// Storage Valet — Create Checkout Edge Function
// v3.2 • Creates Stripe Checkout Session for $99 one-time setup fee
// NOTE: $299/month subscription is started MANUALLY 5-7 days after signup or at first pickup

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Stripe from 'npm:stripe@17'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
})

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
    const body = await req.json().catch(() => ({}))

    const {
      email = '',
      referral_code = '',
      promo_code = '',
    } = body

    // Get Stripe Price ID for $99 one-time setup fee
    const setupFeepriceId = Deno.env.get('STRIPE_PRICE_SETUP_FEE') || 'price_1RzwGeCLlNQ5U3EWMtScwDcd'
    if (!setupFeepriceId) {
      throw new Error('STRIPE_PRICE_SETUP_FEE not configured')
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
      mode: 'payment', // Changed from 'subscription' to 'payment'
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

    // Pre-fill email if provided (from Framer CTA form)
    if (email) {
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
