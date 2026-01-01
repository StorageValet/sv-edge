// Storage Valet — Booking Detail Edge Function
// v1.0 • Fetch single booking detail for authenticated user
//
// Invocation: POST /functions/v1/booking-get (Edge Function)
// Auth: JWT required in Authorization header
// Body: { "booking_id": "uuid" }
// Returns: Full booking detail needed by portal (read-only)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS })
  }

  try {
    // Get auth token from header
    const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'No authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'No token provided' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Verify JWT via Supabase Auth
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      console.error('Auth verification failed:', authError?.message || 'No user returned')
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const userId = user.id

    // Parse request body
    const { booking_id } = await req.json()

    if (!booking_id) {
      return new Response(
        JSON.stringify({ error: 'booking_id is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    console.log(`Booking detail requested: ${booking_id} by user ${userId}`)

    // Service role client for database reads, scoped by user_id
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch booking with ownership check
    const { data: booking, error: fetchError } = await supabase
      .from('actions')
      .select(`
        id,
        user_id,
        status,
        service_type,
        scheduled_start,
        scheduled_end,
        service_address,
        pickup_item_ids,
        delivery_item_ids,
        created_at,
        updated_at
      `)
      .eq('id', booking_id)
      .single()

    if (fetchError || !booking) {
      console.error('Booking not found:', fetchError)
      return new Response(
        JSON.stringify({ error: 'Booking not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Verify ownership
    if (booking.user_id !== userId) {
      console.error(`Ownership mismatch: booking belongs to ${booking.user_id}, requested by ${userId}`)
      return new Response(
        JSON.stringify({ error: 'Booking not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Fetch associated items if any exist
    const allItemIds = [
      ...(booking.pickup_item_ids || []),
      ...(booking.delivery_item_ids || [])
    ]

    let items: any[] = []
    if (allItemIds.length > 0) {
      const { data: itemData, error: itemsError } = await supabase
        .from('items')
        .select('id, label, status, photo_paths, category')
        .in('id', allItemIds)
        .eq('user_id', userId)

      if (!itemsError && itemData) {
        items = itemData
      }
    }

    // Build response (exclude user_id from response, already verified)
    const response = {
      id: booking.id,
      status: booking.status,
      service_type: booking.service_type,
      scheduled_start: booking.scheduled_start,
      scheduled_end: booking.scheduled_end,
      service_address: booking.service_address,
      created_at: booking.created_at,
      updated_at: booking.updated_at,
      items: items,
      item_counts: {
        pickup: (booking.pickup_item_ids || []).length,
        delivery: (booking.delivery_item_ids || []).length,
        total: allItemIds.length
      }
    }

    console.log(`Returning booking ${booking_id} with ${items.length} items`)

    return new Response(
      JSON.stringify({ booking: response }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )

  } catch (error) {
    console.error('Booking detail error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})
