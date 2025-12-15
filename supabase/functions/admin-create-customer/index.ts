// Storage Valet — Admin Create Customer Edge Function
// v1.1 • Fixed staff schema reference (sv.staff not public.staff)
// CTO Mandate: Server-side auth check required (not just UI gating)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CreateCustomerRequest {
  email: string
  first_name?: string
  last_name?: string
  phone?: string
  address?: {
    street?: string
    unit?: string
    city?: string
    state?: string
    zip?: string
  }
  skip_payment?: boolean
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization header required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.replace('Bearer ', '')

    // Initialize Supabase clients
    // User client - to verify caller identity
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })
    // Service client - for admin operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    // Get caller's user ID
    const { data: { user: caller }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !caller) {
      console.error('Auth error:', authError)
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Admin create customer request from user: ${caller.id}`)

    // SERVER-SIDE AUTH CHECK (CTO mandate - not just UI gating)
    // CRITICAL: Staff table is in sv schema, not public
    const { data: staffRecord, error: adminCheckError } = await supabaseAdmin
      .schema('sv')
      .from('staff')
      .select('role')
      .eq('user_id', caller.id)
      .eq('role', 'admin')
      .maybeSingle()

    if (adminCheckError) {
      console.error('Admin check query failed:', adminCheckError)
      return new Response(
        JSON.stringify({ error: `Staff check failed: ${adminCheckError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!staffRecord) {
      console.error('Admin check failed: User not in sv.staff or not admin role')
      return new Response(
        JSON.stringify({ error: 'Access denied: Admin role required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Admin verified: ${caller.id} (role: ${staffRecord.role})`)

    // Parse request body
    const body: CreateCustomerRequest = await req.json()

    // Validate required fields
    if (!body.email) {
      return new Response(
        JSON.stringify({ error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const normalizedEmail = body.email.toLowerCase().trim()

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Creating customer account for: ${normalizedEmail}`)

    // Check if auth user already exists
    const { data: existingUsers } = await supabaseAdmin.rpc(
      'get_user_id_by_email',
      { p_email: normalizedEmail }
    )

    let userId: string

    if (existingUsers) {
      // User already exists in auth.users
      console.log(`Auth user already exists: ${existingUsers}`)
      userId = existingUsers
    } else {
      // Create new auth user with auto-confirmed email
      const { data: newUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
        user_metadata: {
          first_name: body.first_name || '',
          last_name: body.last_name || '',
          created_by_admin: true,
          created_at: new Date().toISOString(),
        }
      })

      if (createUserError) {
        console.error('Failed to create auth user:', createUserError)
        return new Response(
          JSON.stringify({ error: `Failed to create user: ${createUserError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      userId = newUser.user.id
      console.log(`Created new auth user: ${userId}`)
    }

    // Build delivery_address JSONB
    const deliveryAddress = body.address ? {
      street: body.address.street || '',
      unit: body.address.unit || '',
      city: body.address.city || '',
      state: body.address.state || 'NJ',
      zip: body.address.zip || ''
    } : null

    // Determine subscription status
    const subscriptionStatus = body.skip_payment ? 'active' : 'inactive'

    // Upsert customer_profile
    const { error: profileError } = await supabaseAdmin
      .from('customer_profile')
      .upsert({
        user_id: userId,
        email: normalizedEmail,
        full_name: [body.first_name, body.last_name].filter(Boolean).join(' ') || null,
        phone: body.phone || null,
        delivery_address: deliveryAddress,
        subscription_status: subscriptionStatus,
      }, {
        onConflict: 'user_id'
      })

    if (profileError) {
      console.error('Failed to upsert customer_profile:', profileError)
      return new Response(
        JSON.stringify({ error: `Failed to create profile: ${profileError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Customer account created successfully: ${userId}`)

    // Return success with user ID
    return new Response(
      JSON.stringify({
        ok: true,
        user_id: userId,
        email: normalizedEmail,
        subscription_status: subscriptionStatus,
        message: body.skip_payment
          ? 'Customer created with active subscription (payment bypassed)'
          : 'Customer created with inactive subscription (awaiting payment)'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(
      JSON.stringify({ error: `Internal server error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
