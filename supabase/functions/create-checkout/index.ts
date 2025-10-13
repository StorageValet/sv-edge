import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Stripe from 'npm:stripe@17'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json'
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  try {
    // NOTE: This endpoint is PUBLIC by design (no Authorization header required)
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
    const price = Deno.env.get('STRIPE_PRICE_PREMIUM299')!
    const appUrl = Deno.env.get('APP_URL')!

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${appUrl}/dashboard`,
      cancel_url: `${appUrl}/account`,
      metadata: {} // referral_code may be added by Webflow later
    })

    return new Response(JSON.stringify({ url: session.url }), { headers: cors, status: 200 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ error: msg }), { headers: cors, status: 500 })
  }
})
