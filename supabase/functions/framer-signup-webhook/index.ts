// Storage Valet — Framer Signup Webhook
// v1.0 • Captures pre-payment registration data from Framer landing page
// Date: December 6, 2025

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// CORS headers for Framer form submissions
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-client-info, apikey',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Parse request body
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Received signup form submission:', JSON.stringify(body, null, 2))

    // Validate required fields
    const requiredFields = ['first_name', 'last_name', 'email', 'phone', 'street_address', 'city', 'zip_code']
    const missingFields = requiredFields.filter(field => {
      const value = body[field]
      return typeof value !== 'string' || !value.trim()
    })

    if (missingFields.length > 0) {
      console.log(`Missing required fields: ${missingFields.join(', ')}`)
      return new Response(
        JSON.stringify({
          error: `Missing required fields: ${missingFields.join(', ')}`,
          missing: missingFields
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Normalize and sanitize input
    const email = (body.email as string).trim().toLowerCase()
    const firstName = (body.first_name as string).trim()
    const lastName = (body.last_name as string).trim()
    const phone = (body.phone as string).trim()
    const streetAddress = (body.street_address as string).trim()
    const unit = body.unit ? (body.unit as string).trim() : null
    const city = (body.city as string).trim()
    const state = body.state ? (body.state as string).trim() : 'NJ'
    const zipCode = (body.zip_code as string).trim().replace(/\s/g, '').substring(0, 5)
    const referralSource = body.referral_source ? (body.referral_source as string).trim() : null

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      console.log(`Invalid email format: ${email}`)
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client with service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Check service area using existing RPC function
    const { data: isValidZip, error: zipError } = await supabase.rpc('is_valid_zip_code', {
      zip: zipCode
    })

    if (zipError) {
      console.error('Failed to validate ZIP code:', zipError)
      // Don't fail the request - just default to out of area
    }

    const serviceAreaMatch = isValidZip === true
    console.log(`ZIP ${zipCode} service area match: ${serviceAreaMatch}`)

    // Upsert into sv.pre_customers via RPC (sv schema not exposed via PostgREST)
    const { data: preCustomerId, error: upsertError } = await supabase.rpc(
      'upsert_pre_customer',
      {
        p_email: email,
        p_first_name: firstName,
        p_last_name: lastName,
        p_phone: phone,
        p_street_address: streetAddress,
        p_unit: unit,
        p_city: city,
        p_state: state,
        p_zip_code: zipCode,
        p_service_area_match: serviceAreaMatch,
        p_referral_source: referralSource,
      }
    )

    if (upsertError) {
      console.error('Failed to upsert pre_customer:', upsertError)
      throw upsertError
    }

    console.log(`Pre-customer ${preCustomerId} registered: ${email} (ZIP: ${zipCode}, in_area: ${serviceAreaMatch})`)

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        service_area_match: serviceAreaMatch,
        pre_customer_id: preCustomerId,
        message: serviceAreaMatch
          ? 'You are in our service area! Proceed to checkout.'
          : 'We are not yet in your area, but we have added you to our waitlist.'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('framer-signup-webhook error:', error)
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal server error',
        success: false
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
