// Storage Valet — Stripe Webhook Edge Function
// v3.1 • Idempotent webhook handler with signature verification

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13.17.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

// ===============================
// SERVICE AREA ZIP CONFIG (SV v1)
// ===============================
//
// Primary launch zone (INITIAL):
// - Hoboken
// - Weehawken (Port Imperial corridor)
// - Edgewater
// - West New York (Port Imperial north overlap)
// - Jersey City (all standard non-PO-box ZIPs)
//
// IMPORTANT BUSINESS RULES:
//
// 1) This is a **PRIMARY SERVICE AREA**, not an absolute denylist.
//    - If ZIP is inside this list:
//         out_of_service_area = false
//         needs_manual_refund = false
//
//    - If ZIP is NOT in this list:
//         out_of_service_area = true
//         needs_manual_refund = true
//
//    This is a **soft gate** for ops review / special handling,
//    NOT an automatic rejection of the customer.
//
// 2) Zach can expand this list at any time by adding ZIP strings
//    to SERVICE_AREA_ZIPS and redeploying this edge function.
//    No DB migrations required.

const SERVICE_AREA_ZIPS = [
  // Hoboken
  '07030',

  // Weehawken (Port Imperial)
  '07086',

  // Edgewater
  '07020',

  // West New York (Port Imperial overlap)
  '07093',

  // Jersey City (full coverage for launch)
  '07302',
  '07303',
  '07304',
  '07305',
  '07306',
  '07307',
  '07308',
  '07310',
  '07311'
]

// Helper: centralized service area check
function isInServiceArea(zip: string | null | undefined): boolean {
  if (!zip) return false
  return SERVICE_AREA_ZIPS.includes(zip.trim())
}

serve(async (req) => {
  try {
    // Verify Stripe webhook signature
    const signature = req.headers.get('stripe-signature')
    if (!signature) {
      return new Response('Missing signature', { status: 400 })
    }

    const body = await req.text()
    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message)
      return new Response(`Webhook Error: ${err.message}`, { status: 400 })
    }

    // Initialize Supabase client with service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const billing = supabase.schema('billing')

    // IDEMPOTENCY CHECK: Insert event_id first (fails if duplicate)
    const { error: insertError } = await billing
      .from('webhook_events')
      .insert({
        event_id: event.id,
        event_type: event.type,
        payload: event,
      })
      .select()
      .single()

    if (insertError) {
      // Duplicate event (idempotency constraint violation)
      if (insertError.code === '23505') {
        console.log(`Duplicate event ${event.id}, skipping`)
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw insertError
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
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        await handleInvoicePaymentSucceeded(supabase, invoice)
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        await handleInvoicePaymentFailed(supabase, invoice)
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

  // Extract customer details from session
  const name = session.customer_details?.name || null
  const address = session.customer_details?.address

  // Build delivery_address object from Stripe address fields
  const deliveryAddress = address ? {
    street: address.line1 || '',
    unit: address.line2 || null,
    city: address.city || '',
    state: address.state || '',
    zip: address.postal_code || ''
  } : null

  // Extract ZIP for service area validation
  const zip = address?.postal_code || null
  const inServiceArea = isInServiceArea(zip)

  // Set flags based on service area check (soft gate, not hard rejection)
  const outOfServiceArea = !inServiceArea
  const needsManualRefund = !inServiceArea

  console.log(`Address validation: ZIP=${zip}, inServiceArea=${inServiceArea}, outOfServiceArea=${outOfServiceArea}`)

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

  // Determine if this is a setup fee payment or subscription signup
  // Setup fee payments have mode='payment', subscription signups have mode='subscription'
  const isSetupFee = session.mode === 'payment' || session.metadata?.product_type === 'setup_fee'
  const subscriptionId = session.subscription as string | null

  // Upsert customer_profile with address and service area flags
  const { error: profileError } = await supabase.from('customer_profile').upsert(
    {
      user_id: userId,
      email,
      stripe_customer_id: stripeCustomerId,
      // Setup fee: inactive (subscription started manually later)
      // Subscription: active (subscription created immediately)
      subscription_status: isSetupFee ? 'inactive' : 'active',
      subscription_id: subscriptionId,
      // Add customer details and address
      full_name: name,
      delivery_address: deliveryAddress,
      // Service area flags (soft gate for ops review)
      out_of_service_area: outOfServiceArea,
      needs_manual_refund: needsManualRefund,
    },
    { onConflict: 'user_id' }
  )

  if (profileError) {
    console.error('Failed to upsert customer_profile:', profileError)
    throw profileError
  }

  // Upsert billing.customers (denormalized)
  const billing = supabase.schema('billing')
  await billing.from('customers').upsert(
    {
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
    },
    { onConflict: 'user_id' }
  )

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

  // Use SECURITY DEFINER function to update subscription status (bypasses RLS)
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: subscription.status,
    p_subscription_id: subscription.id,
  })

  if (error) {
    console.error(`Failed to update subscription: ${error.message}`)
    throw error
  }

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

  // Use SECURITY DEFINER function to update subscription status (bypasses RLS)
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: 'canceled',
  })

  if (error) {
    console.error(`Failed to update subscription: ${error.message}`)
    throw error
  }

  console.log(`Subscription ${subscription.id} canceled for user ${profile.user_id}`)
}

// Handle invoice payment succeeded
async function handleInvoicePaymentSucceeded(supabase: any, invoice: Stripe.Invoice) {
  const stripeCustomerId = invoice.customer as string

  const { data: profile } = await supabase
    .from('customer_profile')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single()

  if (!profile) {
    console.error(`No profile found for Stripe customer ${stripeCustomerId}`)
    return
  }

  // Use SECURITY DEFINER function to update subscription status (bypasses RLS)
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: 'active',
    p_last_payment_at: new Date().toISOString(),
  })

  if (error) {
    console.error(`Failed to update subscription status: ${error.message}`)
    throw error
  }

  console.log(`Invoice ${invoice.id} payment succeeded for user ${profile.user_id}`)
}

// Handle invoice payment failed
async function handleInvoicePaymentFailed(supabase: any, invoice: Stripe.Invoice) {
  const stripeCustomerId = invoice.customer as string

  const { data: profile } = await supabase
    .from('customer_profile')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single()

  if (!profile) {
    console.error(`No profile found for Stripe customer ${stripeCustomerId}`)
    return
  }

  // Use SECURITY DEFINER function to update subscription status (bypasses RLS)
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: 'past_due',
    p_last_payment_failed_at: new Date().toISOString(),
  })

  if (error) {
    console.error(`Failed to update subscription status: ${error.message}`)
    throw error
  }

  console.log(`Invoice ${invoice.id} payment failed for user ${profile.user_id}`)
}
