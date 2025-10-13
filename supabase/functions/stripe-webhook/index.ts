// Storage Valet — Stripe Webhook Edge Function
// v3.1 • Idempotent webhook handler with signature verification

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17'
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY')!
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

Deno.serve(async (req: Request) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    // Verify Stripe webhook signature
    const signature = req.headers.get('stripe-signature')
    if (!signature) {
      return new Response('Missing signature', { status: 400 })
    }

    // 🔴 CRITICAL: Read raw body as text BEFORE any JSON parsing
    const body = await req.text()
    let event: Stripe.Event

    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('Webhook signature verification failed:', errorMessage)
      return new Response(`Webhook Error: ${errorMessage}`, { status: 400 })
    }

    // Initialize Supabase client with service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // IDEMPOTENCY CHECK: Use direct Postgres connection to access billing schema
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')!
    const client = new Client(dbUrl)
    await client.connect()

    try {
      // Try to insert, catch duplicate key error
      const result = await client.queryObject(
        `INSERT INTO billing.webhook_events (event_id, event_type, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.id, event.type, JSON.stringify(event)]
      )

      if (result.rows.length === 0) {
        // Duplicate event - conflict occurred
        console.log(`Duplicate event ${event.id}, skipping`)
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } finally {
      await client.end()
    }

    // Process event based on type
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutCompleted(supabase, session)
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionChange(supabase, subscription)
        break
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionDeleted(supabase, subscription)
        break
      }
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        console.log(`Invoice ${event.type}:`, invoice.id)
        // Future: update payment status in customer_profile
        break
      }
      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// Handle checkout.session.completed
async function handleCheckoutCompleted(
  supabase: any,
  session: Stripe.Checkout.Session
) {
  const email = session.customer_email || session.customer_details?.email
  const stripeCustomerId = session.customer as string

  if (!email || !stripeCustomerId) {
    console.error('Missing email or customer_id in checkout session')
    return
  }

  // Create or get Auth user via Admin API (auto-confirm)
  const { data: existingUser } = await supabase.auth.admin.getUserByEmail(email)

  let userId: string

  if (existingUser?.user) {
    userId = existingUser.user.id
  } else {
    // Create new Auth user (confirmed, no password)
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true, // Auto-confirm to enable magic links immediately
    })

    if (createError) {
      console.error('Failed to create user:', createError)
      throw createError
    }

    userId = newUser.user.id
  }

  // Upsert customer_profile
  const { error: profileError } = await supabase.from('customer_profile').upsert(
    {
      user_id: userId,
      email,
      stripe_customer_id: stripeCustomerId,
      subscription_status: 'active',
      subscription_id: session.subscription as string,
    },
    { onConflict: 'user_id' }
  )

  if (profileError) {
    console.error('Failed to upsert customer_profile:', profileError)
    throw profileError
  }

  // Upsert billing.customers (denormalized) - use direct SQL
  const dbUrl = Deno.env.get('SUPABASE_DB_URL')!
  const dbClient = new Client(dbUrl)
  await dbClient.connect()
  try {
    await dbClient.queryObject(
      `INSERT INTO billing.customers (user_id, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
      [userId, stripeCustomerId]
    )
  } finally {
    await dbClient.end()
  }

  // Send magic link for first login
  const { error: magicLinkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: {
      redirectTo: `${Deno.env.get('APP_URL')}/dashboard`,
    },
  })

  if (magicLinkError) {
    console.error('Failed to send magic link:', magicLinkError)
    // Non-blocking: customer can request new link via /login
  }

  console.log(`Checkout completed for ${email} (user_id: ${userId})`)
}

// Handle subscription created/updated
async function handleSubscriptionChange(supabase: any, subscription: Stripe.Subscription) {
  const stripeCustomerId = subscription.customer as string

  // Find user by stripe_customer_id
  const { data: profile } = await supabase
    .from('customer_profile')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single()

  if (!profile) {
    console.error(`No profile found for Stripe customer ${stripeCustomerId}`)
    return
  }

  // Update subscription status
  await supabase.from('customer_profile').update({
    subscription_status: subscription.status,
    subscription_id: subscription.id,
  }).eq('user_id', profile.user_id)

  console.log(`Subscription ${subscription.id} updated to ${subscription.status}`)
}

// Handle subscription deleted
async function handleSubscriptionDeleted(supabase: any, subscription: Stripe.Subscription) {
  const stripeCustomerId = subscription.customer as string

  const { data: profile } = await supabase
    .from('customer_profile')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single()

  if (!profile) {
    console.error(`No profile found for Stripe customer ${stripeCustomerId}`)
    return
  }

  await supabase.from('customer_profile').update({
    subscription_status: 'canceled',
  }).eq('user_id', profile.user_id)

  console.log(`Subscription ${subscription.id} canceled for user ${profile.user_id}`)
}
