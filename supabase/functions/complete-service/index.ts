// Storage Valet — Complete Service Edge Function
// Marks pickup or delivery as completed and updates item statuses

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  // CORS preflight
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
    // Require staff authorization
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Parse request
    let body: any
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const { action_id } = body
    if (!action_id) {
      return new Response(JSON.stringify({ error: 'action_id required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // Fetch action
    const { data: action, error: actionError } = await supabase
      .from('actions')
      .select('id, status, service_type, pickup_item_ids, delivery_item_ids')
      .eq('id', action_id)
      .single()

    if (actionError || !action) {
      return new Response(JSON.stringify({ error: 'Action not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // Verify action is in valid state for completion
    if (action.status !== 'in_progress' && action.status !== 'confirmed') {
      return new Response(JSON.stringify({
        error: `Cannot complete: action status is '${action.status}' (expected 'in_progress' or 'confirmed')`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // Update item statuses based on service type
    // PICKUP: items go from 'home' or 'scheduled' → 'stored'
    // DELIVERY: items go from 'stored' or 'scheduled' → 'home'

    if (action.service_type === 'pickup' && action.pickup_item_ids?.length > 0) {
      const { error: updateError } = await supabase
        .from('items')
        .update({ status: 'stored', updated_at: new Date().toISOString() })
        .in('id', action.pickup_item_ids)

      if (updateError) {
        console.error('Failed to update pickup items:', updateError)
      } else {
        console.log(`Updated ${action.pickup_item_ids.length} items to 'stored'`)
      }
    }

    if (action.service_type === 'delivery' && action.delivery_item_ids?.length > 0) {
      const { error: updateError } = await supabase
        .from('items')
        .update({ status: 'home', updated_at: new Date().toISOString() })
        .in('id', action.delivery_item_ids)

      if (updateError) {
        console.error('Failed to update delivery items:', updateError)
      } else {
        console.log(`Updated ${action.delivery_item_ids.length} items to 'home'`)
      }
    }

    // Mark action as completed
    const { data: updatedAction, error: completeError } = await supabase
      .from('actions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', action_id)
      .select()
      .single()

    if (completeError) {
      return new Response(JSON.stringify({ error: 'Failed to complete action' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // Log completion event
    await supabase.rpc('log_booking_event', {
      p_action_id: action_id,
      p_event_type: 'service_completed',
      p_metadata: {
        service_type: action.service_type,
        items_updated: action.service_type === 'pickup'
          ? action.pickup_item_ids?.length || 0
          : action.delivery_item_ids?.length || 0
      }
    })

    return new Response(JSON.stringify({
      ok: true,
      action: updatedAction,
      message: `Service completed: ${action.service_type}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })

  } catch (error) {
    console.error('complete-service error:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }
})
