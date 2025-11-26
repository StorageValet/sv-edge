// Storage Valet — Update Booking Items Edge Function
// v1.0 • Item selection for schedule-first booking flow
//
// Accepts:
// - action_id: UUID of the booking
// - selected_item_ids: Array of item UUIDs
//
// Logic:
// - Verifies action ownership
// - Fetches items and partitions by status (home vs stored)
// - Updates pickup_item_ids and delivery_item_ids arrays
// - Transitions status: pending_items → pending_confirmation

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('PORTAL_ANON_KEY')! // Match portal's key

// Status transition validation
const VALID_TRANSITIONS: Record<string, string[]> = {
  'pending_items': ['pending_confirmation', 'canceled'],
  'pending_confirmation': ['confirmed', 'canceled'],
  'confirmed': ['in_progress', 'canceled'],
  'in_progress': ['completed', 'canceled'],
  'completed': [],  // Terminal state
  'canceled': []    // Terminal state
}

function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) || false
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    })
  }

  try {
    // Verify request method
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    // Get auth token from header
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      console.error('No authorization header provided')
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    console.log('Auth header received, length:', authHeader.length)

    // Extract JWT and decode (don't verify - RLS handles security)
    const token = authHeader.replace('Bearer ', '')
    const payload = JSON.parse(atob(token.split('.')[1]))
    const userId = payload.sub

    if (!userId) {
      console.error('No user ID in JWT')
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    console.log('User ID from JWT:', userId)

    // Initialize Supabase client (RLS will enforce user_id isolation)
    const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceRole)

    // Parse request body
    const { action_id, selected_item_ids } = await req.json()

    if (!action_id || !Array.isArray(selected_item_ids)) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: action_id and selected_item_ids[] required' }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Fetch action and verify ownership
    const { data: action, error: actionError } = await supabase
      .from('actions')
      .select('id, user_id, status')
      .eq('id', action_id)
      .single()

    if (actionError || !action) {
      console.error('Action not found:', actionError)
      return new Response(
        JSON.stringify({ error: 'Action not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Verify ownership (redundant due to RLS, but explicit for clarity)
    if (action.user_id !== userId) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Action does not belong to user' }),
        { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Verify action is in correct state for item selection
    if (!['pending_items', 'pending_confirmation'].includes(action.status)) {
      return new Response(
        JSON.stringify({
          error: `Cannot modify items: action status is '${action.status}' (expected 'pending_items' or 'pending_confirmation')`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Fetch selected items (RLS ensures user can only see their own items)
    const { data: items, error: itemsError } = await supabase
      .from('items')
      .select('id, status')
      .in('id', selected_item_ids)

    if (itemsError) {
      console.error('Failed to fetch items:', itemsError)
      return new Response(
        JSON.stringify({ error: 'Failed to fetch items' }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Partition items by status: home → pickup, stored → delivery
    const pickupItemIds: string[] = []
    const deliveryItemIds: string[] = []

    for (const item of items) {
      if (item.status === 'home') {
        pickupItemIds.push(item.id)
      } else if (item.status === 'stored') {
        deliveryItemIds.push(item.id)
      }
      // Items with status='in_transit' are ignored (shouldn't be selectable)
    }

    // Determine new status - stay in pending_confirmation if already there
    const newStatus = action.status === 'pending_confirmation' ? 'pending_confirmation' : 'pending_confirmation'

    // Skip transition validation if staying in same status (editing items)
    if (action.status !== newStatus && !isValidTransition(action.status, newStatus)) {
      return new Response(
        JSON.stringify({
          error: `Invalid status transition: ${action.status} → ${newStatus}`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Update action with item arrays and new status
    const { data: updatedAction, error: updateError } = await supabase
      .from('actions')
      .update({
        pickup_item_ids: pickupItemIds,
        delivery_item_ids: deliveryItemIds,
        status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', action_id)
      .select()
      .single()

    if (updateError) {
      console.error('Failed to update action:', updateError)
      return new Response(
        JSON.stringify({ error: 'Failed to update booking' }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Log event (using service role client to bypass RLS)
    const supabaseService = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await supabaseService.rpc('log_booking_event', {
      p_action_id: action_id,
      p_event_type: 'items_added',
      p_metadata: {
        pickup_count: pickupItemIds.length,
        delivery_count: deliveryItemIds.length,
        total_items: selected_item_ids.length,
        previous_status: action.status,
        new_status: newStatus
      }
    })

    console.log(`Items updated for action ${action_id}: ${pickupItemIds.length} pickup, ${deliveryItemIds.length} delivery`)

    return new Response(
      JSON.stringify({
        ok: true,
        action: updatedAction,
        summary: {
          pickup_items: pickupItemIds.length,
          delivery_items: deliveryItemIds.length
        }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      }
    )
  } catch (error) {
    console.error('Update booking items error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      }
    )
  }
})
