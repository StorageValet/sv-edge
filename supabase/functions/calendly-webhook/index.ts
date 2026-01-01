// Storage Valet — Calendly Webhook Edge Function
// v2.0 • Schedule-first booking flow with robust logging
//
// Handles:
// - invitee.created: Create/update action in pending_items state
// - invitee.canceled: Mark action as canceled
//
// NOTE: This function uses the Supabase service-role key (bypasses RLS).
// Signature verification is REQUIRED before processing any webhook event.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const calendlySigningKey = Deno.env.get('CALENDLY_WEBHOOK_SIGNING_KEY')
const MAX_CLOCK_SKEW_SECONDS = 5 * 60 // 5 minutes

function parseCalendlySignatureHeader(headerValue: string): { t: string; v1: string } | null {
  // Expected format: "t=1700000000,v1=<hex>" (per Calendly docs/examples)
  const parts = headerValue.split(',').map((p) => p.trim())
  const map = new Map<string, string>()
  for (const part of parts) {
    const [k, ...rest] = part.split('=')
    if (!k || rest.length === 0) continue
    map.set(k.trim(), rest.join('=').trim())
  }
  const t = map.get('t')
  const v1 = map.get('v1')
  if (!t || !v1) return null
  return { t, v1 }
}

function constantTimeEqual(a: string, b: string): boolean {
  // Constant-time-ish compare for ASCII strings (prevents trivial timing leaks)
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

function isFreshTimestampSeconds(t: string): boolean {
  const ts = Number(t)
  if (!Number.isFinite(ts) || ts <= 0) return false
  const now = Math.floor(Date.now() / 1000)
  return Math.abs(now - ts) <= MAX_CLOCK_SKEW_SECONDS
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function computeHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return toHex(sig)
}

async function verifyCalendlySignature(req: Request, rawBody: string): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  // Calendly sends signature header as "Calendly-Webhook-Signature"; some proxies lowercase it.
  const headerValue = req.headers.get('calendly-webhook-signature') || req.headers.get('Calendly-Webhook-Signature')
  if (!headerValue) return { ok: false, status: 401, reason: 'missing_signature_header' }

  if (!calendlySigningKey) {
    // Misconfiguration: fail closed rather than silently accepting unsigned webhooks.
    return { ok: false, status: 500, reason: 'missing_signing_key_env' }
  }

  const parsed = parseCalendlySignatureHeader(headerValue)
  if (!parsed) return { ok: false, status: 401, reason: 'invalid_signature_header_format' }
  if (!isFreshTimestampSeconds(parsed.t)) return { ok: false, status: 401, reason: 'stale_signature_timestamp' }

  // Per Calendly examples: signed payload is `${t}.${rawBody}`
  const signedPayload = `${parsed.t}.${rawBody}`
  const expected = await computeHmacSha256Hex(calendlySigningKey, signedPayload)
  if (!constantTimeEqual(expected, parsed.v1)) return { ok: false, status: 401, reason: 'signature_mismatch' }

  return { ok: true }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, calendly-webhook-signature, calendly-webhook-timestamp',
      },
    })
  }

  try {
    const body = await req.text()

    // Verify webhook authenticity BEFORE any side effects (DB writes, RPC calls)
    const sig = await verifyCalendlySignature(req, body)
    if (!sig.ok) {
      console.error('❌ Calendly webhook rejected:', sig.reason)
      return new Response(JSON.stringify({ error: 'Unauthorized', reason: sig.reason }), {
        status: sig.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    console.log('═══════════════════════════════════════════════════════════')
    console.log('CALENDLY WEBHOOK RECEIVED')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('Body length:', body.length)

    let event: any
    try {
      event = JSON.parse(body)
    } catch (parseError) {
      console.error('Failed to parse webhook body:', parseError)
      console.error('Raw body (first 500 chars):', body.substring(0, 500))
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const eventType = event.event
    console.log('Event type:', eventType)
    console.log('Event received:', { type: eventType, hasPayload: !!event.payload })

    // Initialize Supabase client with service role (bypasses RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Route to appropriate handler
    switch (eventType) {
      case 'invitee.created':
        console.log('→ Routing to handleInviteeCreated')
        await handleInviteeCreated(supabase, event)
        break
      case 'invitee.canceled':
        console.log('→ Routing to handleInviteeCanceled')
        await handleInviteeCanceled(supabase, event)
        break
      default:
        console.log(`⚠️ Unhandled Calendly event type: ${eventType}`)
    }

    console.log('═══════════════════════════════════════════════════════════')
    console.log('CALENDLY WEBHOOK COMPLETED SUCCESSFULLY')
    console.log('═══════════════════════════════════════════════════════════')

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('═══════════════════════════════════════════════════════════')
    console.error('CALENDLY WEBHOOK ERROR')
    console.error('═══════════════════════════════════════════════════════════')
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// Handle invitee.created event
async function handleInviteeCreated(supabase: any, event: any) {
  const payload = event.payload
  console.log('───────────────────────────────────────────────────────────')
  console.log('handleInviteeCreated: Processing payload')

  // Extract key fields from Calendly v2 API payload
  // Email is at payload.email (not nested), times are in scheduled_event
  // Normalize email for case-insensitive matching
  const inviteeEmail = (payload.email || '').toLowerCase().trim()
  const eventUri = payload.scheduled_event?.uri  // Unique Calendly event URI
  const startTime = payload.scheduled_event?.start_time
  const endTime = payload.scheduled_event?.end_time

  console.log('Extracted fields:')
  console.log('  - inviteeEmail:', inviteeEmail)
  console.log('  - eventUri:', eventUri)
  console.log('  - startTime:', startTime)
  console.log('  - endTime:', endTime)

  if (!inviteeEmail || !eventUri || !startTime || !endTime) {
    console.error('❌ Missing required fields in invitee.created payload')
    console.error('  - inviteeEmail present:', !!inviteeEmail)
    console.error('  - eventUri present:', !!eventUri)
    console.error('  - startTime present:', !!startTime)
    console.error('  - endTime present:', !!endTime)
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

  // Lookup customer_profile by email (case-insensitive via ILIKE)
  console.log(`Looking up customer_profile for email: "${inviteeEmail}"`)
  const { data: profile, error: profileError } = await supabase
    .from('customer_profile')
    .select('user_id, delivery_address, email')
    .ilike('email', inviteeEmail)
    .single()

  let userId: string | null = null
  let deliveryAddress: any = null

  if (profile) {
    // Profile found - use it
    console.log(`✓ Found profile for email: "${inviteeEmail}"`)
    console.log('  - user_id:', profile.user_id)
    userId = profile.user_id
    deliveryAddress = profile.delivery_address

    // Log profile found event
    await supabase.rpc('log_booking_event', {
      p_action_id: null,
      p_event_type: 'calendly_profile_found',
      p_metadata: {
        invitee_email: inviteeEmail,
        user_id: userId
      }
    })
  } else {
    // No profile found - check if auth user exists
    console.log(`⚠️ No profile found for email: "${inviteeEmail}"`)
    console.log('  - Checking for auth user...')

    // Use RPC to lookup auth user by email (get_user_id_by_email is SECURITY DEFINER)
    const { data: authUserId, error: authLookupError } = await supabase
      .rpc('get_user_id_by_email', { p_email: inviteeEmail })

    if (authLookupError) {
      console.error('  - Auth lookup error:', authLookupError)
    }

    if (authUserId) {
      // Auth user exists but no profile - auto-create minimal profile
      console.log(`✓ Auth user found: ${authUserId}`)
      console.log('  - Auto-creating profile...')

      const { error: upsertError } = await supabase
        .from('customer_profile')
        .upsert({
          user_id: authUserId,
          email: inviteeEmail,
          subscription_status: 'inactive',  // Not paid yet
        }, { onConflict: 'user_id' })

      if (upsertError) {
        console.error('❌ Failed to auto-create profile:', upsertError)
        // Log error but continue - we still have the user_id
        await supabase.rpc('log_booking_event', {
          p_action_id: null,
          p_event_type: 'calendly_profile_create_failed',
          p_metadata: {
            invitee_email: inviteeEmail,
            user_id: authUserId,
            error: upsertError.message
          }
        })
      } else {
        console.log('✓ Profile auto-created successfully')
        // Log profile creation event
        await supabase.rpc('log_booking_event', {
          p_action_id: null,
          p_event_type: 'calendly_profile_created',
          p_metadata: {
            invitee_email: inviteeEmail,
            user_id: authUserId,
            source: 'calendly_webhook_auto_create'
          }
        })
      }

      userId = authUserId
      // deliveryAddress remains null - user needs to add it later
    } else {
      // No auth user exists - truly orphan booking
      console.error(`❌ No auth user found for email: "${inviteeEmail}"`)
      await supabase.rpc('log_booking_event', {
        p_action_id: null,
        p_event_type: 'calendly_orphan_booking',
        p_metadata: {
          invitee_email: inviteeEmail,
          event_uri: eventUri,
          start_time: startTime,
          end_time: endTime,
          reason: 'no_auth_user'
        }
      })
      return
    }
  }

  // Upsert action (idempotent via calendly_event_uri unique constraint)
  console.log('Upserting action to database...')
  const { data: action, error: actionError } = await supabase
    .from('actions')
    .upsert(
      {
        user_id: userId,
        service_type: 'pickup',  // Default to pickup for schedule-first bookings
        calendly_event_uri: eventUri,
        scheduled_start: startTime,
        scheduled_end: endTime,
        status: 'pending_items',  // Awaiting item selection
        service_address: deliveryAddress,  // Snapshot address at booking time (may be null for auto-created profiles)
        calendly_payload: payload,  // Store full payload for debugging
      },
      { onConflict: 'calendly_event_uri' }
    )
    .select('id')
    .single()

  if (actionError) {
    console.error('❌ Failed to upsert action:', actionError)
    throw actionError
  }

  console.log(`✓ Action upserted successfully: action_id=${action.id}`)

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

  console.log(`✓ Booking event logged for ${inviteeEmail}`)
  console.log('───────────────────────────────────────────────────────────')
}

// Handle invitee.canceled event
async function handleInviteeCanceled(supabase: any, event: any) {
  const payload = event.payload
  console.log('───────────────────────────────────────────────────────────')
  console.log('handleInviteeCanceled: Processing cancellation')

  // Calendly sends scheduled_event.uri for cancellations too
  const eventUri = payload.scheduled_event?.uri  // Calendly event URI
  console.log('  - eventUri:', eventUri)

  if (!eventUri) {
    console.error('❌ Missing event URI in invitee.canceled payload')
    return
  }

  // Find action by calendly_event_uri
  console.log(`Looking up action for eventUri: "${eventUri}"`)
  const { data: action, error: findError } = await supabase
    .from('actions')
    .select('id, user_id, status')
    .eq('calendly_event_uri', eventUri)
    .single()

  if (findError || !action) {
    console.warn(`⚠️ No action found for Calendly event: ${eventUri}`)
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

  console.log(`✓ Found action: action_id=${action.id}, status=${action.status}`)

  // Update action status to canceled
  console.log('Updating action status to canceled...')
  const { error: updateError } = await supabase
    .from('actions')
    .update({
      status: 'canceled',
      updated_at: new Date().toISOString()
    })
    .eq('id', action.id)

  if (updateError) {
    console.error('❌ Failed to cancel action:', updateError)
    throw updateError
  }

  console.log('✓ Action status updated to canceled')

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

  console.log(`✓ Cancellation logged: action_id=${action.id}`)
  console.log('───────────────────────────────────────────────────────────')
}
