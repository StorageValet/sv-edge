// Storage Valet — Stripe Webhook Edge Function
// v3.5 • Integrated with sv.pre_customers for data-first registration flow

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
})

// Required for async webhook verification in Deno edge environment
const cryptoProvider = Stripe.createSubtleCryptoProvider()

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

// Service area ZIP codes (Hoboken, Weehawken, Edgewater, Jersey City, North Bergen)
const SERVICE_AREA_ZIPS = [
  '07030', '07086', '07020', '07087', '07093',
  '07302', '07303', '07304', '07305', '07306',
  '07307', '07308', '07310', '07311', '07047'
]

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
      // Stripe SDK v17+ requires async verification in edge/Deno environments
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret,
        undefined,  // tolerance (default 300s)
        cryptoProvider
      )
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message)
      return new Response(`Webhook Error: ${err.message}`, { status: 400 })
    }

    // Initialize Supabase client with service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // IDEMPOTENCY CHECK: Record event via RPC (returns 'duplicate' if already processed)
    const { data: insertResult, error: insertError } = await supabase.rpc(
      'insert_stripe_webhook_event',
      {
        p_event_id: event.id,
        p_event_type: event.type,
        p_payload: event,
      }
    )

    if (insertError) {
      console.error('Failed to record webhook event:', insertError)
      throw insertError
    }

    if (insertResult === 'duplicate') {
      console.log(`Duplicate event ${event.id}, skipping`)
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Webhook event ${event.id} recorded: ${insertResult}`)

    // Process event based on type
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutCompleted(supabase, session, event.id)
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
  session: Stripe.Checkout.Session,
  eventId: string
) {
  const email = session.customer_email || session.customer_details?.email
  const stripeCustomerId = session.customer as string | null

  // Email is required, but customer_id may be null for $0 promo checkouts
  if (!email) {
    console.error('Missing email in checkout session')
    return
  }

  const normalizedEmail = email.toLowerCase().trim()

  // Log if this is a $0 promo checkout (no Stripe customer created)
  if (!stripeCustomerId) {
    console.log(`$0 promo checkout for ${normalizedEmail} - no Stripe customer created`)
  }

  // === NEW: Check sv.pre_customers for registration data ===
  interface PreCustomer {
    id: string
    email: string
    first_name: string
    last_name: string
    phone: string | null
    street_address: string | null
    unit: string | null
    city: string | null
    state: string
    zip_code: string
    service_area_match: boolean
    referral_source: string | null
    converted_at: string | null
    converted_user_id: string | null
  }

  let preCustomer: PreCustomer | null = null
  const { data: preCustomerRows, error: preCustomerError } = await supabase.rpc(
    'get_pre_customer_by_email',
    { p_email: normalizedEmail }
  )

  if (preCustomerError) {
    console.error('Failed to query pre_customers:', preCustomerError)
    // Continue without pre_customer data
  } else if (preCustomerRows && preCustomerRows.length > 0) {
    preCustomer = preCustomerRows[0]
    console.log(`Found pre_customer for ${normalizedEmail}: ${preCustomer.id}`)
  } else {
    // Log anomaly: checkout without pre-registration
    console.log(`No pre_customer found for ${normalizedEmail} - logging anomaly`)
    await supabase.rpc('log_signup_anomaly', {
      p_email: normalizedEmail,
      p_stripe_customer_id: stripeCustomerId,
      p_anomaly_type: 'missing_pre_customer',
      p_event_id: eventId,
      p_raw_data: { session_id: session.id, mode: session.mode }
    })
  }

  // Create or get Auth user via Admin API (auto-confirm)
  const { data: existingUser, error: lookupError } = await supabase.auth.admin.getUserByEmail(normalizedEmail)

  if (lookupError) {
    console.error('Failed to lookup user:', lookupError)
    // Don't throw - might just mean user doesn't exist
  }

  let userId: string

  if (existingUser?.user) {
    userId = existingUser.user.id
    console.log(`Found existing user for ${normalizedEmail}: ${userId}`)
  } else {
    // Create new Auth user (confirmed, no password)
    // Include name from pre_customer if available
    console.log(`Creating new user for ${normalizedEmail}`)
    const userMetadata = preCustomer ? {
      first_name: preCustomer.first_name,
      last_name: preCustomer.last_name,
    } : undefined

    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: true, // Auto-confirm to enable magic links immediately
      user_metadata: userMetadata,
    })

    if (createError) {
      console.error('Failed to create user:', createError)
      throw createError
    }

    if (!newUser?.user?.id) {
      console.error('User created but no ID returned')
      throw new Error('User created but no ID returned')
    }

    userId = newUser.user.id
    console.log(`Created new user for ${normalizedEmail}: ${userId}`)
  }

  // Determine if this is a setup fee payment or subscription signup
  // Setup fee payments have mode='payment', subscription signups have mode='subscription'
  const isSetupFee = session.mode === 'payment' || session.metadata?.product_type === 'setup_fee'
  const subscriptionId = session.subscription as string | null

  // Extract and validate service area (soft gate - don't block checkout)
  const address = session.customer_details?.address
  const postalCode = address?.postal_code?.replace(/\s/g, '') // Remove spaces

  // Use pre_customer service area status if available, otherwise check Stripe address
  const inServiceArea = preCustomer
    ? preCustomer.service_area_match
    : (postalCode ? SERVICE_AREA_ZIPS.includes(postalCode) : false)
  const outOfServiceArea = !inServiceArea
  const needsManualRefund = outOfServiceArea

  // Build delivery address - prefer pre_customer data if available
  const deliveryAddress = preCustomer ? {
    line1: preCustomer.street_address,
    line2: preCustomer.unit || null,
    city: preCustomer.city,
    state: preCustomer.state,
    zip: preCustomer.zip_code,
    country: 'US'
  } : (address ? {
    line1: address.line1,
    line2: address.line2 || null,
    city: address.city,
    state: address.state,
    zip: postalCode,
    country: address.country
  } : null)

  // Calculate setup fee amount from session (cents to dollars)
  const setupFeeAmount = session.amount_total ? session.amount_total / 100 : 99.00

  // Upsert customer_profile with pre_customer data if available
  console.log(`Upserting profile for ${normalizedEmail} (user_id: ${userId}, stripe_customer_id: ${stripeCustomerId || 'null'})`)
  const { error: profileError } = await supabase.from('customer_profile').upsert(
    {
      user_id: userId,
      email: normalizedEmail,
      stripe_customer_id: stripeCustomerId,
      // Setup fee: inactive (subscription started manually later)
      // Subscription: active (subscription created immediately)
      subscription_status: isSetupFee ? 'inactive' : 'active',
      subscription_id: subscriptionId,
      // Service area validation (soft gate)
      delivery_address: deliveryAddress,
      out_of_service_area: outOfServiceArea,
      needs_manual_refund: needsManualRefund,
      // === NEW FIELDS from pre_customer ===
      setup_fee_paid: true,
      setup_fee_amount: setupFeeAmount,
      first_name: preCustomer?.first_name || null,
      last_name: preCustomer?.last_name || null,
      full_name: preCustomer ? `${preCustomer.first_name} ${preCustomer.last_name}` : null,
      phone: preCustomer?.phone || null,
    },
    { onConflict: 'user_id' }
  )

  if (profileError) {
    console.error('Failed to upsert customer_profile:', profileError)
    throw profileError
  }

  // === NEW: Mark pre_customer as converted ===
  if (preCustomer) {
    const { error: convertError } = await supabase.rpc('mark_pre_customer_converted', {
      p_pre_customer_id: preCustomer.id,
      p_user_id: userId,
    })

    if (convertError) {
      console.error('Failed to mark pre_customer as converted:', convertError)
      // Non-blocking: profile is already created
    } else {
      console.log(`Pre-customer ${preCustomer.id} marked as converted`)
    }
  }

  // Upsert billing.customers via RPC (only if we have a Stripe customer ID)
  if (stripeCustomerId) {
    const { error: billingError } = await supabase.rpc('upsert_billing_customer', {
      p_user_id: userId,
      p_stripe_customer_id: stripeCustomerId,
    })

    if (billingError) {
      console.error('Failed to upsert billing.customers:', billingError)
      // Non-blocking: customer_profile is the source of truth
    }
  }

  // Send magic link for first login (deferred per plan - keeping existing behavior)
  const { error: magicLinkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: normalizedEmail,
    options: {
      redirectTo: `${Deno.env.get('APP_URL')}/dashboard`,
    },
  })

  if (magicLinkError) {
    console.error('Failed to send magic link:', magicLinkError)
    // Non-blocking: customer can request new link via /login
  }

  const zipForLog = preCustomer?.zip_code || postalCode || 'none'
  console.log(`Checkout completed for ${normalizedEmail} (user_id: ${userId}, ZIP: ${zipForLog}, in_service_area: ${inServiceArea}, setup_fee: $${setupFeeAmount})`)
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
