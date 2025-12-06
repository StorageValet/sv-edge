// Storage Valet — Create Checkout Edge Function
// v3.4 • Reuse existing Stripe customer to avoid duplicates
// NOTE: $299/month subscription is started MANUALLY 5-7 days after signup or at first pickup

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  try {
    // Parse request body (optional: referral_code, promo_code, email)
    let body: any
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const {
      email = '',
      referral_code = '',
      promo_code = '',
    } = body

    // Check if authenticated user already has a Stripe customer ID
    // Reuse existing Stripe customer if present to avoid duplicates.
    // customer_creation: 'always' remains as a safety net for new customers.
    let existingStripeCustomerId: string | null = null
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization')

    if (authHeader) {
      try {
        const token = authHeader.replace(/^Bearer\s+/i, '')
        const supabase = createClient(supabaseUrl, supabaseServiceKey)
        const { data: { user } } = await supabase.auth.getUser(token)

        if (user) {
          // Query customer_profile for existing stripe_customer_id
          const { data: profile, error: profileError } = await supabase
            .from('customer_profile')
            .select('stripe_customer_id')
            .eq('user_id', user.id)
            .maybeSingle()

          if (profileError) {
            console.error('Failed to lookup existing customer:', profileError)
            // Continue without existing customer - will create new one
          } else if (profile?.stripe_customer_id) {
            existingStripeCustomerId = profile.stripe_customer_id
            console.log(`Reusing existing Stripe customer: ${existingStripeCustomerId}`)
          }
        }
      } catch (authError) {
        console.error('Auth lookup failed:', authError)
        // Continue without existing customer - will create new one
      }
    }

    // Get Stripe Price ID for $99 one-time setup fee
    const setupFeepriceId = Deno.env.get('STRIPE_PRICE_SETUP_FEE')
    if (!setupFeepriceId) {
      throw new Error('STRIPE_PRICE_SETUP_FEE environment variable not configured')
    }

    // Build metadata for referral tracking
    const metadata: Record<string, string> = {
      product_type: 'setup_fee',
      subscription_start_method: 'manual', // Indicates subscription will be started manually
    }
    if (referral_code) metadata.referral_code = referral_code
    if (promo_code) metadata.promo_code = promo_code

    // Create Stripe Checkout Session for ONE-TIME PAYMENT (not subscription)
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      customer_creation: 'always', // Ensure Stripe customer is created even for $0 promo checkouts
      line_items: [
        {
          price: setupFeepriceId,
          quantity: 1,
        },
      ],
      success_url: `${Deno.env.get('APP_URL') || 'https://portal.mystoragevalet.com'}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${Deno.env.get('APP_URL') || 'https://portal.mystoragevalet.com'}`,
      metadata,
      allow_promotion_codes: true, // Enable promo codes in Stripe UI (can discount/waive setup fee)
    }

    // Reuse existing Stripe customer if found, otherwise pre-fill email
    if (existingStripeCustomerId) {
      sessionParams.customer = existingStripeCustomerId
      // Note: when customer is set, customer_email is ignored by Stripe
    } else if (email) {
      sessionParams.customer_email = email
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    return new Response(
      JSON.stringify({ url: session.url }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    )
  } catch (error) {
    console.error('create-checkout error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    )
  }
})
