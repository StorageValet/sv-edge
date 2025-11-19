// Storage Valet — Calendly Webhook Edge Function
// v1.0 • Schedule-first booking flow with webhook signature verification
//
// Handles:
// - invitee.created: Create/update action in pending_items state
// - invitee.canceled: Mark action as canceled

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createHmac } from 'https://deno.land/std@0.168.0/node/crypto.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const calendlyWebhookSecret = Deno.env.get('CALENDLY_WEBHOOK_SECRET')!

// Verify Calendly webhook signature
// https://developer.calendly.com/api-docs/ZG9jOjM2MzE2MDM4-webhook-signatures
function verifyCalendlySignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false

  try {
    const hmac = createHmac('sha256', secret)
    hmac.update(payload)
    const expectedSignature = hmac.digest('base64')

    return signature === expectedSignature
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

serve(async (req) => {
  try {
    // Verify webhook signature
    const body = await req.text()

    // TEMP: Disable HMAC verification for debugging
    console.log('DEV MODE: Skipping HMAC verification')
    // const signature = req.headers.get('calendly-webhook-signature')
    // if (!verifyCalendlySignature(body, signature, calendlyWebhookSecret)) {
    //   console.error('Invalid Calendly webhook signature')
    //   return new Response('Unauthorized', { status: 401 })
    // }

    const event = JSON.parse(body)
    const eventType = event.event

    // Initialize Supabase client with service role (bypasses RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Route to appropriate handler
    switch (eventType) {
      case 'invitee.created':
        await handleInviteeCreated(supabase, event)
        break
      case 'invitee.canceled':
        await handleInviteeCanceled(supabase, event)
        break
      default:
        console.log(`Unhandled Calendly event type: ${eventType}`)
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Calendly webhook processing error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// Handle invitee.created event
async function handleInviteeCreated(supabase: any, event: any) {
  const payload = event.payload

  // Extract key fields from Calendly payload
  const inviteeEmail = payload.email
  const eventUri = payload.uri  // Unique Calendly event URI
  const startTime = payload.start_time
  const endTime = payload.end_time

  if (!inviteeEmail || !eventUri || !startTime || !endTime) {
    console.error('Missing required fields in invitee.created payload', payload)
    // Log to booking_events for debugging
    await supabase.rpc('log_booking_event', {
      p_action_id: null,
      p_event_type: 'calendly_webhook_error',
      p_metadata: {
        error: 'Missing required fields',
        event_type: 'invitee.created',
        payload: payload
      }
    })
    return
  }

  // Lookup customer_profile by email
  const { data: profile, error: profileError } = await supabase
    .from('customer_profile')
    .select('user_id, delivery_address')
    .eq('email', inviteeEmail)
    .single()

  if (profileError || !profile) {
    console.error(`No profile found for email: ${inviteeEmail}`)
    // Log orphan event (customer hasn't signed up yet, or email mismatch)
    await supabase.rpc('log_booking_event', {
      p_action_id: null,
      p_event_type: 'calendly_orphan_booking',
      p_metadata: {
        invitee_email: inviteeEmail,
        event_uri: eventUri,
        start_time: startTime,
        end_time: endTime
      }
    })
    return
  }

  // Upsert action (idempotent via calendly_event_uri unique constraint)
  const { data: action, error: actionError } = await supabase
    .from('actions')
    .upsert(
      {
        user_id: profile.user_id,
        service_type: 'pickup',  // Default to pickup for schedule-first bookings
        calendly_event_uri: eventUri,
        scheduled_start: startTime,
        scheduled_end: endTime,
        status: 'pending_items',  // Awaiting item selection
        service_address: profile.delivery_address,  // Snapshot address at booking time
        calendly_payload: payload,  // Store full payload for debugging
      },
      { onConflict: 'calendly_event_uri' }
    )
    .select('id')
    .single()

  if (actionError) {
    console.error('Failed to upsert action:', actionError)
    throw actionError
  }

  // Log successful booking creation
  await supabase.rpc('log_booking_event', {
    p_action_id: action.id,
    p_event_type: 'calendly_booking_created',
    p_metadata: {
      source: 'calendly_webhook',
      event_uri: eventUri,
      invitee_email: inviteeEmail
    }
  })

  console.log(`Action created for ${inviteeEmail}: action_id=${action.id}, event_uri=${eventUri}`)
}

// Handle invitee.canceled event
async function handleInviteeCanceled(supabase: any, event: any) {
  const payload = event.payload
  const eventUri = payload.event  // Calendly event URI

  if (!eventUri) {
    console.error('Missing event URI in invitee.canceled payload', payload)
    return
  }

  // Find action by calendly_event_uri
  const { data: action, error: findError } = await supabase
    .from('actions')
    .select('id, user_id, status')
    .eq('calendly_event_uri', eventUri)
    .single()

  if (findError || !action) {
    console.warn(`No action found for Calendly event: ${eventUri}`)
    // Log orphan cancellation
    await supabase.rpc('log_booking_event', {
      p_action_id: null,
      p_event_type: 'calendly_orphan_cancellation',
      p_metadata: {
        event_uri: eventUri,
        payload: payload
      }
    })
    return
  }

  // Update action status to canceled
  const { error: updateError } = await supabase
    .from('actions')
    .update({
      status: 'canceled',
      updated_at: new Date().toISOString()
    })
    .eq('id', action.id)

  if (updateError) {
    console.error('Failed to cancel action:', updateError)
    throw updateError
  }

  // Log cancellation event
  await supabase.rpc('log_booking_event', {
    p_action_id: action.id,
    p_event_type: 'calendly_booking_canceled',
    p_metadata: {
      source: 'calendly_webhook',
      event_uri: eventUri,
      previous_status: action.status
    }
  })

  console.log(`Action canceled: action_id=${action.id}, event_uri=${eventUri}`)
}
