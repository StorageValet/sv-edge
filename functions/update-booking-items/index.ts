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
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

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
  try {
    // Verify request method
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    // Get auth token from header
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response('Unauthorized', { status: 401 })
    }

    // Initialize Supabase client with user's auth token (enforces RLS)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { authorization: authHeader },
      },
    })

    // Verify user authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      console.error('Auth error:', authError)
      return new Response('Unauthorized', { status: 401 })
    }

    // Parse request body
    const { action_id, selected_item_ids } = await req.json()

    if (!action_id || !Array.isArray(selected_item_ids)) {
      return new Response(
        JSON.stringify({ error: 'Invalid request: action_id and selected_item_ids[] required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
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
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Verify ownership (redundant due to RLS, but explicit for clarity)
    if (action.user_id !== user.id) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Action does not belong to user' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Verify action is in correct state for item selection
    if (!['pending_items', 'pending_confirmation'].includes(action.status)) {
      return new Response(
        JSON.stringify({
          error: `Cannot modify items: action status is '${action.status}' (expected 'pending_items' or 'pending_confirmation')`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
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
        { status: 500, headers: { 'Content-Type': 'application/json' } }
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

    // Validate transition to pending_confirmation
    const newStatus = 'pending_confirmation'
    if (!isValidTransition(action.status, newStatus)) {
      return new Response(
        JSON.stringify({
          error: `Invalid status transition: ${action.status} → ${newStatus}`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
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
        { status: 500, headers: { 'Content-Type': 'application/json' } }
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
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Update booking items error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
