// Storage Valet — Create Checkout Trial Edge Function
// v1.0 • Billing v2: 14-day free trial with subscription mode
// Date: January 7, 2026
// NOTE: Trial starts immediately, card required at checkout, billing begins day 15

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Allowed origins (marketing site only)
const ALLOWED_ORIGINS = [
  'https://storage-valet-website.vercel.app',  // Staging
  'https://www.mystoragevalet.com',            // Production
  'https://mystoragevalet.com',                // Apex
]

// Default base URL for return URLs when origin missing or not allowed
const DEFAULT_BASE_URL = 'https://www.mystoragevalet.com'

// Map origin to base URL for Stripe return URLs
function getBaseUrl(origin: string | null): string {
  if (!origin) return DEFAULT_BASE_URL
  if (ALLOWED_ORIGINS.includes(origin)) return origin
  return DEFAULT_BASE_URL
}

// Get CORS headers for a given origin (returns null if not allowed)
function getCorsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin) {
    // No origin header - return base headers without ACAO
    return {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }
  }
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }
  }
  // Origin present but not allowed
  return null
}

serve(async (req) => {
  const origin = req.headers.get('Origin') || req.headers.get('origin')
  const corsHeaders = getCorsHeaders(origin)
  const baseUrl = getBaseUrl(origin)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    if (origin && !corsHeaders) {
      // Origin present but not allowed
      console.error(`CORS rejected for origin: ${origin}`)
      return new Response('Forbidden', { status: 403 })
    }
    return new Response(null, { status: 204, headers: corsHeaders || {} })
  }

  // Check CORS for non-OPTIONS requests
  if (origin && !corsHeaders) {
    console.error(`CORS rejected for origin: ${origin}`)
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Build response headers (may not include ACAO if no origin)
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

  try {
    // Parse request body (optional: email)
    let body: any
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
        status: 400,
        headers: responseHeaders
      })
    }

    const { email = '' } = body

    // Check if authenticated user already has a Stripe customer ID
    // Reuse existing Stripe customer if present to avoid duplicates.
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

    // Get Stripe Price ID for monthly subscription
    const monthlyPriceId = Deno.env.get('STRIPE_PRICE_MONTHLY')
    if (!monthlyPriceId) {
      throw new Error('STRIPE_PRICE_MONTHLY environment variable not configured')
    }

    // Build metadata for trial tracking
    const metadata: Record<string, string> = {
      billing_version: 'v2_trial_14d',
    }

    // Create Stripe Checkout Session for SUBSCRIPTION with 14-day trial
    // CRITICAL: payment_method_collection: 'always' ensures card is required even for $0 trial
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [
        {
          price: monthlyPriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          billing_version: 'v2_trial_14d',
        },
      },
      payment_method_collection: 'always',  // CRITICAL: Require card even for $0 trial
      success_url: `${baseUrl}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/signup/canceled`,
      metadata,
      // Note: allow_promotion_codes removed for trial (no promos on subscription)
    }

    // Reuse existing Stripe customer if found, otherwise pre-fill email
    if (existingStripeCustomerId) {
      sessionParams.customer = existingStripeCustomerId
      // Note: when customer is set, customer_email is ignored by Stripe
    } else if (email) {
      sessionParams.customer_email = email
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    console.log(`Trial checkout session created for ${email || 'unknown'}, redirecting to ${baseUrl}`)

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: responseHeaders }
    )
  } catch (error) {
    console.error('create-checkout-trial error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders }
    )
  }
})
