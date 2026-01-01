// Storage Valet — Bookings List Edge Function
// v1.0 • List bookings for authenticated user
//
// Invocation: POST /functions/v1/bookings-list (Edge Function)
// Auth: JWT required in Authorization header
// Returns: List of bookings ordered by scheduled_start ASC

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
    console.log('Bookings list requested by user:', userId)

    // Service role client for database reads, scoped by user_id
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch bookings for user, ordered by scheduled_start ASC
    // Only return fields needed for portal list view (no internal arrays)
    const { data: bookings, error: fetchError } = await supabase
      .from('actions')
      .select(`
        id,
        status,
        service_type,
        scheduled_start,
        scheduled_end,
        created_at,
        updated_at
      `)
      .eq('user_id', userId)
      .order('scheduled_start', { ascending: true, nullsFirst: false })

    if (fetchError) {
      console.error('Failed to fetch bookings:', fetchError)
      return new Response(
        JSON.stringify({ error: 'Failed to fetch bookings' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    console.log(`Returning ${bookings?.length || 0} bookings for user ${userId}`)

    return new Response(
      JSON.stringify({ bookings: bookings || [] }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )

  } catch (error) {
    console.error('Bookings list error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})
