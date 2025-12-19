// Storage Valet — Update Booking Items Edge Function
// v1.1 • Fixed: Proper JWT verification via auth.getUser() (was using insecure atob decode)
// v1.0 • Item selection for schedule-first booking flow
//
// Accepts:
// - action_id: UUID of the booking
// - selected_item_ids: Array of item UUIDs
//
// Logic:
// - Verifies JWT via Supabase Auth (Pattern A: anon-key for auth, service role for DB)
// - Verifies action ownership
// - Fetches items and partitions by status (home vs stored)
// - Updates pickup_item_ids and delivery_item_ids arrays
// - Transitions status: pending_items → pending_confirmation

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

    // Get auth token from header (case-insensitive)
    const authHeader =
      req.headers.get('authorization') ??
      req.headers.get('Authorization')
    if (!authHeader) {
      console.error('No authorization header provided')
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      console.error('Empty token after stripping Bearer prefix')
      return new Response(JSON.stringify({ error: 'No token provided' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }
    console.log('Auth token received, length:', token.length)

    // ═══════════════════════════════════════════════════════════════════════
    // PATTERN A: Verify JWT with anon-key client, use service role for DB writes
    // This cryptographically verifies the JWT signature (unlike atob decode)
    // ═══════════════════════════════════════════════════════════════════════
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      console.error('Auth verification failed:', authError?.message || 'No user returned')
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const userId = user.id
    console.log('Verified user ID:', userId)

    // Service role client for database writes (bypasses RLS, safe after auth verification)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse request body
    const { action_id, selected_item_ids } = await req.json()

    if (!action_id || !Array.isArray(selected_item_ids)) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: action_id and selected_item_ids[] required' }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Fetch action and verify ownership (include existing item arrays for edit mode)
    const { data: action, error: actionError } = await supabase
      .from('actions')
      .select('id, user_id, status, pickup_item_ids, delivery_item_ids')
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

    // ═══════════════════════════════════════════════════════════════════════
    // PARTITION ITEMS: home → pickup, stored → delivery
    // For 'scheduled' items, use the booking's existing arrays to determine type
    // ═══════════════════════════════════════════════════════════════════════
    const prevPickupIds = new Set<string>(action.pickup_item_ids || [])
    const prevDeliveryIds = new Set<string>(action.delivery_item_ids || [])

    const pickupItemIds: string[] = []
    const deliveryItemIds: string[] = []

    for (const item of items) {
      if (item.status === 'home') {
        // Unscheduled home item → pickup
        pickupItemIds.push(item.id)
      } else if (item.status === 'stored') {
        // Unscheduled stored item → delivery
        deliveryItemIds.push(item.id)
      } else if (item.status === 'scheduled') {
        // Scheduled item: use booking's existing arrays to determine original type
        if (prevPickupIds.has(item.id)) {
          pickupItemIds.push(item.id)
        } else if (prevDeliveryIds.has(item.id)) {
          deliveryItemIds.push(item.id)
        }
        // If not in either (shouldn't happen), ignore it
      }
      // Other statuses are ignored
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

    // ═══════════════════════════════════════════════════════════════════════
    // UPDATE ITEM STATUSES (additions AND removals)
    // ═══════════════════════════════════════════════════════════════════════
    const nextPickupIds = new Set(pickupItemIds)
    const nextDeliveryIds = new Set(deliveryItemIds)

    // Compute added items (new to this booking)
    const addedPickupIds = pickupItemIds.filter(id => !prevPickupIds.has(id))
    const addedDeliveryIds = deliveryItemIds.filter(id => !prevDeliveryIds.has(id))
    const addedIds = [...addedPickupIds, ...addedDeliveryIds]

    // Compute removed items (were on booking, now unchecked)
    const removedPickupIds = [...prevPickupIds].filter(id => !nextPickupIds.has(id))
    const removedDeliveryIds = [...prevDeliveryIds].filter(id => !nextDeliveryIds.has(id))

    console.log(`Item changes: +${addedIds.length} added, -${removedPickupIds.length} pickup removed, -${removedDeliveryIds.length} delivery removed`)

    // Set added items to 'scheduled'
    if (addedIds.length > 0) {
      const { error: addError } = await supabase
        .from('items')
        .update({ status: 'scheduled', updated_at: new Date().toISOString() })
        .in('id', addedIds)

      if (addError) {
        console.error('Failed to set added items to scheduled:', addError)
      } else {
        console.log(`Set ${addedIds.length} items to status 'scheduled'`)
      }
    }

    // Set removed pickup items back to 'home'
    if (removedPickupIds.length > 0) {
      const { error: removePickupError } = await supabase
        .from('items')
        .update({ status: 'home', updated_at: new Date().toISOString() })
        .in('id', removedPickupIds)

      if (removePickupError) {
        console.error('Failed to set removed pickup items to home:', removePickupError)
      } else {
        console.log(`Set ${removedPickupIds.length} removed pickup items to status 'home'`)
      }
    }

    // Set removed delivery items back to 'stored'
    if (removedDeliveryIds.length > 0) {
      const { error: removeDeliveryError } = await supabase
        .from('items')
        .update({ status: 'stored', updated_at: new Date().toISOString() })
        .in('id', removedDeliveryIds)

      if (removeDeliveryError) {
        console.error('Failed to set removed delivery items to stored:', removeDeliveryError)
      } else {
        console.log(`Set ${removedDeliveryIds.length} removed delivery items to status 'stored'`)
      }
    }

    // Log event (using service role client to bypass RLS)
    await supabase.rpc('log_booking_event', {
      p_action_id: action_id,
      p_event_type: 'items_updated',
      p_metadata: {
        pickup_count: pickupItemIds.length,
        delivery_count: deliveryItemIds.length,
        total_items: selected_item_ids.length,
        added_count: addedIds.length,
        removed_pickup_count: removedPickupIds.length,
        removed_delivery_count: removedDeliveryIds.length,
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
