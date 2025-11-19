#!/bin/bash
# Storage Valet - Webhook Deployment and Testing Script
# Run this after Supabase Management API recovers

set -e  # Exit on any error

echo "========================================="
echo "Storage Valet Webhook Deployment"
echo "========================================="
echo ""

# Check if Supabase API is accessible
echo "1. Testing Supabase API connectivity..."
if ! supabase projects list &>/dev/null; then
  echo "❌ ERROR: Supabase Management API still unavailable (500 errors)"
  echo "   Wait for API to recover before running this script."
  exit 1
fi
echo "✅ Supabase API is accessible"
echo ""

# Deploy webhook functions
echo "2. Deploying webhook functions..."
echo "   - stripe-webhook (with ZIP validation, JWT disabled)"
supabase functions deploy stripe-webhook --no-verify-jwt
echo ""
echo "   - calendly-webhook (JWT disabled, HMAC verification)"
supabase functions deploy calendly-webhook --no-verify-jwt
echo ""

# Verify deployment status
echo "3. Verifying deployment status..."
supabase functions list
echo ""

# Wait for deployment to propagate
echo "4. Waiting 5 seconds for deployment propagation..."
sleep 5
echo ""

# Test JWT configuration
echo "5. Testing JWT configuration (should return non-401)..."
echo ""

echo "   Testing stripe-webhook:"
STRIPE_RESPONSE=$(curl -s -X POST https://gmjucacmbrumncfnnhua.supabase.co/functions/v1/stripe-webhook \
  -H "Content-Type: application/json" \
  -d '{"test":true}' \
  -w "\nStatus: %{http_code}\n")

echo "$STRIPE_RESPONSE"

if echo "$STRIPE_RESPONSE" | grep -q "Status: 401"; then
  echo "❌ ERROR: stripe-webhook still returning 401 (JWT blocking)"
  echo "   Check deno.json and supabase.toml config"
else
  echo "✅ stripe-webhook JWT config correct"
fi
echo ""

echo "   Testing calendly-webhook:"
CALENDLY_RESPONSE=$(curl -s -X POST https://gmjucacmbrumncfnnhua.supabase.co/functions/v1/calendly-webhook \
  -H "Content-Type: application/json" \
  -d '{"test":true}' \
  -w "\nStatus: %{http_code}\n")

echo "$CALENDLY_RESPONSE"

if echo "$CALENDLY_RESPONSE" | grep -q "Status: 401"; then
  echo "❌ ERROR: calendly-webhook still returning 401 (JWT blocking)"
  echo "   Check deno.json and supabase.toml config"
else
  echo "✅ calendly-webhook JWT config correct"
fi
echo ""

echo "========================================="
echo "Deployment Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Set CALENDLY_WEBHOOK_SECRET: supabase secrets set CALENDLY_WEBHOOK_SECRET=<value>"
echo "2. Verify schema with queries in verify-schema.sql"
echo "3. Test end-to-end Calendly booking flow"
echo "4. Before production: Re-enable HMAC verification in calendly-webhook"
echo ""
