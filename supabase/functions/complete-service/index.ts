// Storage Valet — Complete Service Edge Function
// v2.3 • Atomic completion + fail closed on item errors (fixes race condition, prevents duplicate emails)
// v2.2 • Added transactional email sending via Resend (pickup_complete, delivery_complete)
// v2.1 • Fixed staff schema reference (sv.staff not public.staff)
// Marks pickup or delivery as completed and updates item statuses

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Send transactional email via send-email edge function (fire-and-forget)
async function sendTransactionalEmail(
  type: 'welcome' | 'pickup_complete' | 'delivery_complete' | 'payment_failed',
  to: string,
  data: { firstName?: string; itemCount?: number }
) {
  try {
    const sendEmailUrl = `${supabaseUrl}/functions/v1/send-email`
    const response = await fetch(sendEmailUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ type, to, data }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`Failed to send ${type} email to ${to}:`, error)
    } else {
      const result = await response.json()
      console.log(`Sent ${type} email to ${to} (id: ${result.id})`)
    }
  } catch (error) {
    // Non-blocking: log but don't throw
    console.error(`Error sending ${type} email to ${to}:`, error)
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Require authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.replace('Bearer ', '')

    // Create user client to verify caller identity
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })

    // Get caller's user ID
    const { data: { user: caller }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !caller) {
      console.error('Auth error:', authError)
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Complete-service request from user: ${caller.id}`)

    // Service role client for privileged operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // SERVER-SIDE STAFF CHECK (CTO mandate - not just UI gating)
    // CRITICAL: Staff table is in sv schema, not public
    const { data: staffRecord, error: staffErr } = await supabase
      .schema('sv')
      .from('staff')
      .select('role')
      .eq('user_id', caller.id)
      .maybeSingle()

    if (staffErr) {
      console.error('Staff check query failed:', staffErr)
      return new Response(JSON.stringify({ error: `Staff check failed: ${staffErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!staffRecord) {
      console.error('Staff check failed: User not in sv.staff table')
      return new Response(JSON.stringify({ error: 'Forbidden: staff only' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Staff verified: ${caller.id} (role: ${staffRecord.role})`)

    // Parse request
    let body: any
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { action_id } = body
    if (!action_id) {
      return new Response(JSON.stringify({ error: 'action_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Fetch action (include user_id for email lookup)
    const { data: action, error: actionError } = await supabase
      .from('actions')
      .select('id, user_id, status, service_type, pickup_item_ids, delivery_item_ids')
      .eq('id', action_id)
      .single()

    if (actionError || !action) {
      return new Response(JSON.stringify({ error: 'Action not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Verify action is in valid state for completion
    // Valid states: 'confirmed' (standard flow) or 'pending_confirmation' (edge case)
    // Note: 'in_progress' is not used in the current workflow
    const completableStatuses = ['confirmed', 'pending_confirmation']
    if (!completableStatuses.includes(action.status)) {
      return new Response(JSON.stringify({
        error: `Cannot complete: action status is '${action.status}' (expected 'confirmed' or 'pending_confirmation')`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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
        return new Response(JSON.stringify({ error: 'Failed to update pickup items' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`Updated ${action.pickup_item_ids.length} items to 'stored'`)
    }

    if (action.service_type === 'delivery' && action.delivery_item_ids?.length > 0) {
      const { error: updateError } = await supabase
        .from('items')
        .update({ status: 'home', updated_at: new Date().toISOString() })
        .in('id', action.delivery_item_ids)

      if (updateError) {
        console.error('Failed to update delivery items:', updateError)
        return new Response(JSON.stringify({ error: 'Failed to update delivery items' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`Updated ${action.delivery_item_ids.length} items to 'home'`)
    }

    // Mark action as completed (ATOMIC: only if still in completable state)
    // This prevents race conditions where concurrent calls could both complete + email
    const { data: updatedAction, error: completeError } = await supabase
      .from('actions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', action_id)
      .in('status', ['confirmed', 'pending_confirmation'])
      .select()
      .maybeSingle()

    if (completeError) {
      console.error('Failed to complete action:', completeError)
      return new Response(JSON.stringify({ error: 'Failed to complete action' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // If no row returned, the action was not in a completable state (already completed or changed).
    // Treat as idempotent success and DO NOT send email.
    if (!updatedAction) {
      console.log(`Action ${action_id} not completable (already completed or status changed). Skipping email.`)
      return new Response(JSON.stringify({
        ok: true,
        already_completed: true,
        message: 'Action already completed or not in a completable state'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Log completion event (non-blocking)
    const itemsUpdated = action.service_type === 'pickup'
      ? action.pickup_item_ids?.length || 0
      : action.delivery_item_ids?.length || 0

    await supabase.rpc('log_booking_event', {
      p_action_id: action_id,
      p_event_type: 'service_completed',
      p_metadata: {
        service_type: action.service_type,
        items_updated: itemsUpdated,
        completed_by: caller.id
      }
    }).catch(err => console.error('Failed to log booking event:', err))

    console.log(`Service completed: ${action.service_type} for action ${action_id} (${itemsUpdated} items updated)`)

    // Send service completion email (non-blocking)
    // Look up customer profile for email and first_name
    const { data: customerProfile } = await supabase
      .from('customer_profile')
      .select('email, first_name')
      .eq('user_id', action.user_id)
      .single()

    if (customerProfile?.email) {
      const emailType = action.service_type === 'pickup' ? 'pickup_complete' : 'delivery_complete'
      sendTransactionalEmail(emailType, customerProfile.email, {
        firstName: customerProfile.first_name || undefined,
        itemCount: itemsUpdated,
      })
    } else {
      console.log(`No customer email found for user ${action.user_id}, skipping service email`)
    }

    return new Response(JSON.stringify({
      ok: true,
      action: updatedAction,
      message: `Service completed: ${action.service_type}`,
      items_updated: itemsUpdated
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('complete-service error:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
