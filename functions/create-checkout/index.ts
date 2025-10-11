// Storage Valet — Create Checkout Edge Function
// v3.1 • Creates Stripe Checkout Session for $299/month premium tier

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
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

    // Get Stripe Price ID for $299/month tier
    const priceId = Deno.env.get('STRIPE_PRICE_PREMIUM299')
    if (!priceId) {
      throw new Error('STRIPE_PRICE_PREMIUM299 not configured')
    }

    // Build metadata for referral tracking
    const metadata: Record<string, string> = {}
    if (referral_code) metadata.referral_code = referral_code
    if (promo_code) metadata.promo_code = promo_code

    // Create Stripe Checkout Session
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${Deno.env.get('APP_URL')}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${Deno.env.get('APP_URL') || 'https://mystoragevalet.com'}`,
      metadata,
      allow_promotion_codes: true, // Enable promo codes in Stripe UI
    }

    // Pre-fill email if provided (from Webflow CTA form)
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
