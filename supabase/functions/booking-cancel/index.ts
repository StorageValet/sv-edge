// Storage Valet — Booking Cancel Edge Function
// v1.0 • Cancel a booking and revert associated item states
//
// Invocation: POST /functions/v1/booking-cancel (Edge Function)
// Auth: JWT required in Authorization header
// Body: { "booking_id": "uuid" }
//
// Customer-allowed states for cancellation:
// - pending_items
// - pending_confirmation
//
// On cancel:
// - Items in pickup_item_ids → revert to 'home'
// - Items in delivery_item_ids → revert to 'stored'
// - Booking status → 'canceled'
//
// Idempotent: Canceling twice returns 200 (no error)
// Does NOT call Calendly API (webhooks reconcile if needed)

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

// States where customer can cancel
const CUSTOMER_CANCELABLE_STATES = ['pending_items', 'pending_confirmation']

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

    console.log(`Cancel requested for booking ${booking_id} by user ${userId}`)

    // Service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch booking with ownership check
    const { data: booking, error: fetchError } = await supabase
      .from('actions')
      .select('id, user_id, status, pickup_item_ids, delivery_item_ids')
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

    // Idempotent: if already canceled, return success
    if (booking.status === 'canceled') {
      console.log(`Booking ${booking_id} already canceled, returning success (idempotent)`)
      return new Response(
        JSON.stringify({ ok: true, status: 'canceled' }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Verify customer can cancel from current state
    if (!CUSTOMER_CANCELABLE_STATES.includes(booking.status)) {
      console.error(`Cannot cancel: booking status is '${booking.status}', allowed: ${CUSTOMER_CANCELABLE_STATES.join(', ')}`)
      return new Response(
        JSON.stringify({
          error: 'Cannot cancel booking',
          reason: `Booking status is '${booking.status}'. Cancellation is only allowed for bookings in pending states. Please contact support.`
        }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const pickupItemIds = booking.pickup_item_ids || []
    const deliveryItemIds = booking.delivery_item_ids || []
    const now = new Date().toISOString()

    console.log(`Reverting ${pickupItemIds.length} pickup items to 'home', ${deliveryItemIds.length} delivery items to 'stored'`)

    // Revert pickup items to 'home'
    if (pickupItemIds.length > 0) {
      const { error: pickupRevertError } = await supabase
        .from('items')
        .update({ status: 'home', updated_at: now })
        .in('id', pickupItemIds)
        .eq('user_id', userId)

      if (pickupRevertError) {
        console.error('Failed to revert pickup items:', pickupRevertError)
        // Continue anyway - booking cancel is more important
      } else {
        console.log(`Reverted ${pickupItemIds.length} pickup items to 'home'`)
      }
    }

    // Revert delivery items to 'stored'
    if (deliveryItemIds.length > 0) {
      const { error: deliveryRevertError } = await supabase
        .from('items')
        .update({ status: 'stored', updated_at: now })
        .in('id', deliveryItemIds)
        .eq('user_id', userId)

      if (deliveryRevertError) {
        console.error('Failed to revert delivery items:', deliveryRevertError)
        // Continue anyway - booking cancel is more important
      } else {
        console.log(`Reverted ${deliveryItemIds.length} delivery items to 'stored'`)
      }
    }

    // Update booking status to canceled
    const { error: cancelError } = await supabase
      .from('actions')
      .update({ status: 'canceled', updated_at: now })
      .eq('id', booking_id)
      .eq('user_id', userId)

    if (cancelError) {
      console.error('Failed to cancel booking:', cancelError)
      return new Response(
        JSON.stringify({ error: 'Failed to cancel booking' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Log booking event
    await supabase.rpc('log_booking_event', {
      p_action_id: booking_id,
      p_event_type: 'portal_booking_canceled',
      p_metadata: {
        previous_status: booking.status,
        pickup_items_reverted: pickupItemIds.length,
        delivery_items_reverted: deliveryItemIds.length,
        canceled_by: 'customer',
        user_id: userId
      }
    })

    console.log(`Booking ${booking_id} canceled successfully`)

    return new Response(
      JSON.stringify({ ok: true, status: 'canceled' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )

  } catch (error) {
    console.error('Booking cancel error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})
