# sv-edge — Storage Valet Supabase Edge Functions

**Version:** v3.1
**Purpose:** Serverless Edge Functions for Stripe integration and secret management

## Structure

```
sv-edge/
└── functions/
    ├── create-portal-session/     # Generate Stripe Customer Portal URL
    ├── create-checkout/            # Create Stripe Checkout Session
    └── stripe-webhook/             # Process Stripe webhook events
```

## Functions

### create-portal-session
**Trigger:** `/account` page "Manage Billing" button
**Auth:** Requires valid Supabase JWT
**Flow:**
1. Extract user from JWT
2. Query `customer_profile.stripe_customer_id`
3. Create Stripe Customer Portal session
4. Return short-lived URL

**Environment variables:**
- `STRIPE_SECRET_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL`

### create-checkout
**Trigger:** Webflow CTA (public, no auth required)
**Flow:**
1. Accept optional `email`, `referral_code`, `promo_code` from request body
2. Create Stripe Checkout Session for `STRIPE_PRICE_PREMIUM299`
3. Return checkout URL
4. Success redirects to `{APP_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`

**Environment variables:**
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_PREMIUM299` (price_live_xxx)
- `APP_URL`

### stripe-webhook
**Trigger:** Stripe webhook events (configured in Stripe Dashboard)
**Security:** Signature verification with `STRIPE_WEBHOOK_SECRET`
**Idempotency:** Log-first approach via `billing.webhook_events(event_id)` UNIQUE constraint

**Flow:**
1. Verify webhook signature
2. Insert `event_id` into `webhook_events` (fails fast on duplicate)
3. Process event based on type:
   - `checkout.session.completed`: Create Auth user (auto-confirm), upsert profile, send magic link
   - `customer.subscription.created/updated`: Update subscription status
   - `customer.subscription.deleted`: Mark as canceled
   - `invoice.payment_*`: Log only (future: update payment status)

**Environment variables:**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL`

## Events Subscribed

Configure in Stripe Dashboard → Webhooks:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

## Deployment

```bash
# Deploy all functions
supabase functions deploy create-portal-session
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook

# Set secrets
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
supabase secrets set STRIPE_PRICE_PREMIUM299=price_live_xxx
supabase secrets set APP_URL=https://portal.mystoragevalet.com
```

## Testing Locally

```bash
supabase functions serve --env-file .env.local

# Test create-checkout
curl -X POST http://localhost:54321/functions/v1/create-checkout \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# Test webhook (use Stripe CLI)
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook
stripe trigger checkout.session.completed
```

## Key Features

- **Signature verification**: All webhook events verified via Stripe SDK
- **Idempotency**: Duplicate events short-circuit via UNIQUE constraint
- **Auto-confirm users**: New customers are email-confirmed immediately
- **Magic link delivery**: Sent automatically after checkout completion
- **RLS-safe**: Uses service role key; Auth policies enforced at row level

---

### Project docs
Core specs & runbooks: **https://github.com/mystoragevalet/sv-docs**

- Implementation Plan v3.1
- Final Validation Checklist v3.1
- Deployment Instructions v3.1
- Go–NoGo (Line in the Sand) v3.1
- Business Context & Requirements v3.1
- Runbooks (webhook tests, env setup, smoke tests)
