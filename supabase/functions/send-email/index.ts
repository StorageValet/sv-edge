// Storage Valet — Send Email Edge Function
// v1.0 • Resend API integration for transactional emails
// Triggered internally by stripe-webhook and complete-service

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const RESEND_API_URL = 'https://api.resend.com/emails'

// Sender configuration (verified domain)
const FROM_EMAIL = 'Storage Valet <concierge@mystoragevalet.com>'
const REPLY_TO = 'hello@mystoragevalet.com'
const PORTAL_URL = 'https://portal.mystoragevalet.com'

// CORS headers for internal function calls
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

// HTML email templates (matching Resend dashboard designs)
function getEmailContent(type: EmailType, data: EmailRequest['data']): { subject: string; html: string } {
  const firstName = data.firstName || 'there'

  switch (type) {
    case 'welcome':
      return {
        subject: "Welcome to Storage Valet – Here's What Happens Next",
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1d3557; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #1d3557; margin-bottom: 24px;">Welcome to Storage Valet, ${firstName}!</h1>

  <p>You're officially part of Hudson County's premium pickup-and-store service. We're excited to help you reclaim your space!</p>

  <h2 style="color: #1d3557; margin-top: 32px;">What Happens Next</h2>

  <ol style="padding-left: 20px;">
    <li style="margin-bottom: 16px;">
      <strong>Create your inventory</strong> – Add items in your portal with names, descriptions, keywords, and photos. This makes it easy to find exactly what you need later—search "holiday decorations" and instantly locate your Christmas ornaments, tree, or wreath.
    </li>
    <li style="margin-bottom: 16px;">
      <strong>Schedule your first pickup</strong> – Choose a time that works for you. We'll come to your home and collect your items.
    </li>
    <li style="margin-bottom: 16px;">
      <strong>We store your items securely</strong> – Everything is protected by $3,000 insurance coverage and stored safely until you need it.
    </li>
    <li style="margin-bottom: 16px;">
      <strong>Request delivery anytime</strong> – Select individual items or batch multiple items for redelivery. You can even swap items—get winter gear delivered while we pick up summer items in the same visit.
    </li>
  </ol>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${PORTAL_URL}" style="background-color: #c56a47; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Create Your First Item</a>
  </div>

  <p style="margin-top: 32px;">Questions? Just reply to this email – we're here to help.</p>

  <p style="margin-top: 24px;">Warmly,<br>The Storage Valet Team</p>
</body>
</html>
        `
      }

    case 'pickup_complete':
      const itemCount = data.itemCount || 0
      const itemText = itemCount === 1 ? 'one of your items' : `${itemCount} of your items`
      return {
        subject: 'Storage Valet Pickup Confirmation',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1d3557; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #1d3557; margin-bottom: 24px;">Pickup Confirmation</h1>

  <p>Hi ${firstName},</p>

  <p>Great news! We've successfully picked up ${itemText}. Rest assured, your belongings are safe and secure, each protected by your account's insurance coverage.</p>

  <p>You can schedule the delivery of these items or any others whenever you need them. Just a quick reminder: we kindly ask for a minimum of 48 hours' notice for pickups and deliveries. You can also schedule these events up to a year in advance, so feel free to plan ahead!</p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${PORTAL_URL}" style="background-color: #c56a47; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">View Your Inventory</a>
  </div>

  <p>If you have any questions or need assistance, don't hesitate to contact support.</p>

  <p style="margin-top: 24px;">Warmly,<br>The Storage Valet Team</p>
</body>
</html>
        `
      }

    case 'delivery_complete':
      const deliveredCount = data.itemCount || 0
      const deliveredText = deliveredCount === 1 ? 'one of your items' : `${deliveredCount} of your items`
      return {
        subject: 'Storage Valet Delivery Confirmation',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1d3557; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #1d3557; margin-bottom: 24px;">Delivery Confirmation</h1>

  <p>Hi ${firstName},</p>

  <p>We've successfully delivered ${deliveredText} back to you.</p>

  <p>If you need to schedule another pickup or delivery, you can do so anytime through your portal. As a reminder, we kindly ask for a minimum of 48 hours' notice, and you can schedule up to a year in advance.</p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${PORTAL_URL}" style="background-color: #c56a47; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Go to Your Portal</a>
  </div>

  <p>If you have any questions or need assistance, don't hesitate to contact support.</p>

  <p style="margin-top: 24px;">Warmly,<br>The Storage Valet Team</p>
</body>
</html>
        `
      }

    case 'payment_failed':
      return {
        subject: 'Action Needed: Payment Issue',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1d3557; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #1d3557; margin-bottom: 24px;">Action Needed: Payment Issue</h1>

  <p>Hi ${firstName},</p>

  <p>We weren't able to process your most recent payment. This can happen if your card expired or there was a temporary issue with your bank.</p>

  <h2 style="color: #1d3557; margin-top: 32px;">What to Do</h2>

  <p>Please update your payment method in your portal within the next <strong>7 days</strong> to avoid any interruption to your service.</p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${PORTAL_URL}/account" style="background-color: #c56a47; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Update Payment Method</a>
  </div>

  <p style="background-color: #f8f9fa; padding: 16px; border-radius: 6px; margin-top: 24px;">
    <strong>Your items are safe.</strong> We'll hold everything securely while you update your payment information.
  </p>

  <p style="margin-top: 32px;">Need help? Just reply to this email and we'll assist you.</p>

  <p style="margin-top: 24px;">Warmly,<br>The Storage Valet Team</p>
</body>
</html>
        `
      }

    default:
      throw new Error(`Unknown email type: ${type}`)
  }
}

// Send email via Resend API
async function sendEmail(request: EmailRequest): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const { subject, html } = getEmailContent(request.type, request.data)

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [request.to],
        subject,
        html,
        reply_to: REPLY_TO,
      }),
    })

    const result = await response.json()

    if (!response.ok) {
      console.error('Resend API error:', result)
      return { success: false, error: result.message || 'Failed to send email' }
    }

    console.log(`Email sent: ${request.type} to ${request.to} (id: ${result.id})`)
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
