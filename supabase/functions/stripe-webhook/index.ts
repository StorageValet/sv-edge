// Storage Valet — Stripe Webhook Edge Function
// v4.0 • Billing v2: Full trial lifecycle support (trialing status, trial_end_at, cancel tracking)
// v3.11 • Added transactional email sending via Resend (welcome, payment_failed)
// v3.10 • Made setup_fee_paid/setup_fee_amount conditional on isSetupFee (future-proof)
// v3.9 • Fixed setup-fee payment timestamp: write last_payment_at using Stripe event time
// v3.8 • Removed unused generateLink call (Option A: user requests magic link from /login)
// v3.7 • Fixed user lookup: use RPC function instead of non-existent getUserByEmail
// v3.6 • Fixed idempotency: record event AFTER successful processing

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

// Send transactional email via send-email edge function (fire-and-forget)
async function sendTransactionalEmail(
  type: 'welcome' | 'pickup_complete' | 'delivery_complete' | 'payment_failed',
  to: string,
  data: { firstName?: string; itemCount?: number }
) {
  try {
    const sendEmailUrl = `${supabaseUrl}/functions/v1/send-email`
    const response = await fetch(sendEmailUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ type, to, data }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`Failed to send ${type} email to ${to}:`, error)
    } else {
      const result = await response.json()
      console.log(`Sent ${type} email to ${to} (id: ${result.id})`)
    }
  } catch (error) {
    // Non-blocking: log but don't throw
    console.error(`Error sending ${type} email to ${to}:`, error)
  }
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

    // IDEMPOTENCY CHECK: Check if event was already SUCCESSFULLY processed
    // NOTE: We check BEFORE processing, but only INSERT after SUCCESS
    // This allows retries after failures while preventing duplicate processing
    const { data: eventExists, error: checkError } = await supabase.rpc(
      'check_stripe_webhook_event',
      { p_event_id: event.id }
    )

    // If check fails, log but continue (fail open for reliability)
    if (checkError) {
      console.error('Failed to check existing event:', checkError)
      // Continue processing - better to risk duplicate than miss event
    }

    if (eventExists === true) {
      console.log(`Duplicate event ${event.id}, skipping (already processed)`)
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Processing webhook event ${event.id}: ${event.type}`)

    // Process event based on type
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutCompleted(supabase, session, event.id, event.created)
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

    // RECORD EVENT: Only after successful processing
    // This ensures retries work correctly if processing fails
    const { error: insertError } = await supabase.rpc(
      'insert_stripe_webhook_event',
      {
        p_event_id: event.id,
        p_event_type: event.type,
        p_payload: event,
      }
    )

    if (insertError) {
      // Log but don't fail - processing already succeeded
      console.error('Failed to record webhook event (processing succeeded):', insertError)
    } else {
      console.log(`Webhook event ${event.id} recorded after successful processing`)
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
  eventId: string,
  eventCreatedAt: number  // Stripe timestamp (seconds since epoch)
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
  // NOTE: Supabase JS v2 does NOT have getUserByEmail - use RPC function instead
  console.log(`Looking up existing user for email: ${normalizedEmail}`)
  const { data: existingUserId, error: lookupError } = await supabase.rpc(
    'get_user_id_by_email',
    { p_email: normalizedEmail }
  )

  if (lookupError) {
    console.error('Failed to lookup user by email:', lookupError)
    // Don't throw - we'll try to create the user
  }

  let userId: string

  if (existingUserId) {
    userId = existingUserId
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

  // Determine checkout mode:
  // - mode='payment' → Legacy setup fee (v1)
  // - mode='subscription' → New trial subscription (v2)
  const isSetupFee = session.mode === 'payment' || session.metadata?.product_type === 'setup_fee'
  const isTrialSubscription = session.mode === 'subscription'
  const subscriptionId = session.subscription as string | null

  // === v4.0: For subscription checkouts, retrieve full subscription to get trial data ===
  let trialEndAt: string | null = null
  let initialStatus: string = 'inactive'
  let billingVersion: string | null = null
  let cancelAtPeriodEnd = false
  let cancelAt: string | null = null

  if (isTrialSubscription && subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)

      // Extract trial data
      if (subscription.trial_end) {
        trialEndAt = new Date(subscription.trial_end * 1000).toISOString()
      }

      // Set initial status based on subscription state
      initialStatus = subscription.status // 'trialing', 'active', etc.

      // Get billing version from subscription metadata
      billingVersion = subscription.metadata?.billing_version || 'v2_trial_14d'

      // Cancellation tracking
      cancelAtPeriodEnd = subscription.cancel_at_period_end
      if (subscription.cancel_at) {
        cancelAt = new Date(subscription.cancel_at * 1000).toISOString()
      }

      console.log(`Subscription ${subscriptionId}: status=${initialStatus}, trial_end=${trialEndAt}, billing_version=${billingVersion}`)
    } catch (subError) {
      console.error('Failed to retrieve subscription details:', subError)
      // Fall back to 'trialing' for new trial subscriptions
      initialStatus = 'trialing'
      billingVersion = 'v2_trial_14d'
    }
  } else if (isSetupFee) {
    // Legacy v1 setup fee: inactive until subscription started manually
    initialStatus = 'inactive'
  }

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
  // NOTE: Portal expects 'street' and 'unit', not 'line1' and 'line2'
  const deliveryAddress = preCustomer ? {
    street: preCustomer.street_address,
    unit: preCustomer.unit || null,
    city: preCustomer.city,
    state: preCustomer.state,
    zip: preCustomer.zip_code,
    country: 'US'
  } : (address ? {
    street: address.line1,
    unit: address.line2 || null,
    city: address.city,
    state: address.state,
    zip: postalCode,
    country: address.country
  } : null)

  // Calculate setup fee amount from session (cents to dollars)
  const setupFeeAmount = session.amount_total ? session.amount_total / 100 : 99.00

  // Calculate payment timestamp from Stripe event time (only for setup-fee checkouts)
  // Uses Stripe's event.created (seconds since epoch) for accurate payment time
  const paymentTimestamp = isSetupFee
    ? new Date(eventCreatedAt * 1000).toISOString()
    : null

  // Upsert customer_profile with pre_customer data if available
  console.log(`Upserting profile for ${normalizedEmail} (user_id: ${userId}, stripe_customer_id: ${stripeCustomerId || 'null'}, status: ${initialStatus})`)
  const { error: profileError } = await supabase.from('customer_profile').upsert(
    {
      user_id: userId,
      email: normalizedEmail,
      stripe_customer_id: stripeCustomerId,
      // v4.0: Use dynamically determined status (trialing for v2, inactive for v1)
      subscription_status: initialStatus,
      subscription_id: subscriptionId,
      // Service area validation (soft gate)
      delivery_address: deliveryAddress,
      out_of_service_area: outOfServiceArea,
      needs_manual_refund: needsManualRefund,
      // === Setup fee fields (only for mode='payment' checkouts) ===
      ...(isSetupFee && { setup_fee_paid: true, setup_fee_amount: setupFeeAmount }),
      first_name: preCustomer?.first_name || null,
      last_name: preCustomer?.last_name || null,
      full_name: preCustomer ? `${preCustomer.first_name} ${preCustomer.last_name}` : null,
      phone: preCustomer?.phone || null,
      // === v3.9: Payment timestamp for setup-fee checkouts ===
      ...(paymentTimestamp && { last_payment_at: paymentTimestamp }),
      // === v4.0: Billing v2 trial columns ===
      ...(trialEndAt && { trial_end_at: trialEndAt }),
      ...(billingVersion && { billing_version: billingVersion }),
      cancel_at_period_end: cancelAtPeriodEnd,
      ...(cancelAt && { cancel_at: cancelAt }),
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

  // NOTE: Magic link email is handled by Supabase Auth when user requests it from /login
  // We removed the generateLink call here since it generated a link but didn't use it
  // For Option A (branded magic link), the email template is configured in Supabase Dashboard

  const zipForLog = preCustomer?.zip_code || postalCode || 'none'
  console.log(`Checkout completed for ${normalizedEmail} (user_id: ${userId}, ZIP: ${zipForLog}, in_service_area: ${inServiceArea}, setup_fee: $${setupFeeAmount}, last_payment_at: ${paymentTimestamp || 'null'})`)

  // Send welcome email (non-blocking)
  sendTransactionalEmail('welcome', normalizedEmail, {
    firstName: preCustomer?.first_name || undefined,
  })
}

// Handle subscription created/updated
// v4.0: Extended to pass trial and cancellation tracking fields
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

  // === v4.0: Extract trial and cancellation data ===
  const trialEndAt = subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toISOString()
    : null

  const cancelAt = subscription.cancel_at
    ? new Date(subscription.cancel_at * 1000).toISOString()
    : null

  const billingVersion = subscription.metadata?.billing_version || null

  // Use SECURITY DEFINER function to update subscription status (bypasses RLS)
  // v4.0: Extended with trial and cancellation params
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: subscription.status,
    p_subscription_id: subscription.id,
    // v4.0 params (null values preserved by COALESCE in RPC)
    p_trial_end_at: trialEndAt,
    p_cancel_at_period_end: subscription.cancel_at_period_end,
    p_cancel_at: cancelAt,
    p_billing_version: billingVersion,
  })

  if (error) {
    console.error(`Failed to update subscription: ${error.message}`)
    throw error
  }

  console.log(`Subscription ${subscription.id} updated: status=${subscription.status}, trial_end=${trialEndAt || 'none'}, cancel_at_period_end=${subscription.cancel_at_period_end}`)
}

// Handle subscription deleted
// v4.0: Clears trial_end_at and cancel_at since subscription is now fully canceled
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
  // v4.0: Clear trial and cancellation columns since subscription is now deleted
  // Note: The RPC uses COALESCE, so we need to handle clearing via direct update for nulls
  // For now, set status to canceled - trial_end_at/cancel_at become historical reference
  const { error } = await supabase.rpc('update_subscription_status', {
    p_user_id: profile.user_id,
    p_status: 'canceled',
    p_cancel_at_period_end: false,  // No longer pending cancel - it's done
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
    .select('user_id, email, first_name')
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

  // Send payment failed email (non-blocking)
  if (profile.email) {
    sendTransactionalEmail('payment_failed', profile.email, {
      firstName: profile.first_name || undefined,
    })
  }
}
