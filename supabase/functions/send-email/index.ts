// Storage Valet — Send Email Edge Function
// v2.0 • Refactored to use Resend Template API (templates managed in Resend dashboard)
// v1.1 • Added service role authentication (security fix)
// v1.0 • Resend API integration for transactional emails
// Triggered internally by stripe-webhook and complete-service

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const RESEND_API_URL = 'https://api.resend.com/emails'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// Sender configuration (verified domain)
const FROM_EMAIL = 'Storage Valet <concierge@mystoragevalet.com>'
const REPLY_TO = 'hello@mystoragevalet.com'

// Resend Template IDs (managed in Resend dashboard at resend.com/templates)
// Edit templates directly in Resend dashboard - no code changes needed
const TEMPLATE_IDS: Record<EmailType, string> = {
  welcome: '963800f2-0703-4314-92d0-b3ea6faa8e14',
  pickup_complete: 'e7327dc3-5e7b-47f1-994c-fbbd5b0a0e6f',
  delivery_complete: '197827cf-1c6c-458d-9d68-03b2e75c78d3',
  payment_failed: 'c22b0071-cfaf-4d1c-a38c-18dc5655c4b8',
}

// Subject lines for each email type
const SUBJECT_LINES: Record<EmailType, string> = {
  welcome: "Welcome to Storage Valet – Here's What Happens Next",
  pickup_complete: 'Your Items Are Safely With Us!',
  delivery_complete: 'Your Items Are Home!',
  payment_failed: 'Action Needed: Payment Issue',
}

// CORS headers for internal function calls
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Validate caller is using service role key (internal functions only)
function validateServiceRoleAuth(req: Request): boolean {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return false

  const token = authHeader.replace('Bearer ', '')
  return token === SUPABASE_SERVICE_ROLE_KEY
}

// Email template types
type EmailType = 'welcome' | 'pickup_complete' | 'delivery_complete' | 'payment_failed'

interface EmailRequest {
  type: EmailType
  to: string
  data: {
    firstName?: string
    itemCount?: number
    itemNames?: string[]
  }
}

// Build template variables for Resend
// Note: To use these variables, add {{{FIRST_NAME}}}, {{{ITEM_COUNT}}} etc.
// to your templates in the Resend dashboard
function buildTemplateVariables(type: EmailType, data: EmailRequest['data']): Record<string, string | number> {
  const variables: Record<string, string | number> = {}

  // Common variables
  if (data.firstName) {
    variables.FIRST_NAME = data.firstName
  }

  // Item-related variables for pickup/delivery
  if (type === 'pickup_complete' || type === 'delivery_complete') {
    if (data.itemCount !== undefined) {
      variables.ITEM_COUNT = data.itemCount
      // Pre-computed text for templates that don't want to do logic
      variables.ITEM_TEXT = data.itemCount === 1
        ? 'one of your items'
        : `${data.itemCount} of your items`
    }
  }

  return variables
}

// Send email via Resend Template API
async function sendEmail(request: EmailRequest): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured')
    return { success: false, error: 'Email service not configured' }
  }

  const templateId = TEMPLATE_IDS[request.type]
  if (!templateId) {
    console.error(`No template ID configured for type: ${request.type}`)
    return { success: false, error: `Unknown email type: ${request.type}` }
  }

  try {
    const variables = buildTemplateVariables(request.type, request.data)

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [request.to],
        subject: SUBJECT_LINES[request.type],
        reply_to: REPLY_TO,
        // Use Resend Template API
        template: {
          id: templateId,
          variables: Object.keys(variables).length > 0 ? variables : undefined,
        },
      }),
    })

    const result = await response.json()

    if (!response.ok) {
      console.error('Resend API error:', result)
      return { success: false, error: result.message || 'Failed to send email' }
    }

    console.log(`Email sent: ${request.type} to ${request.to} (id: ${result.id}, template: ${templateId})`)
    return { success: true, id: result.id }
  } catch (error) {
    console.error('Send email error:', error)
    return { success: false, error: error.message }
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // SECURITY: Validate service role authentication
    // Only internal edge functions (stripe-webhook, complete-service) should call this
    if (!validateServiceRoleAuth(req)) {
      console.error('Unauthorized send-email attempt (missing or invalid service role key)')
      return new Response(JSON.stringify({ error: 'Unauthorized: service role key required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Parse request
    const body: EmailRequest = await req.json()

    if (!body.type || !body.to) {
      return new Response(JSON.stringify({ error: 'type and to are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Validate email type
    const validTypes: EmailType[] = ['welcome', 'pickup_complete', 'delivery_complete', 'payment_failed']
    if (!validTypes.includes(body.type)) {
      return new Response(JSON.stringify({ error: `Invalid email type. Valid types: ${validTypes.join(', ')}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Send email
    const result = await sendEmail(body)

    if (result.success) {
      return new Response(JSON.stringify({ ok: true, id: result.id }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    } else {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  } catch (error) {
    console.error('send-email error:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
