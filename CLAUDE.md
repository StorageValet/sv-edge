# 🚦 **READ FIRST — AI AGENT STARTUP RULES (SYSTEM PROTECTION BLOCK)**

**Last Verified Stable Date:** **Dec 6, 2025**
**Environment:** Production (Vercel + Supabase)
**Status:** All systems healthy, repos clean, and fully deployed.

### Recent Critical Fix (Dec 6, 2025)
**Stripe webhook was silently failing for 7 weeks** (Oct 13 - Dec 5). Root cause: Stripe SDK v17 requires async signature verification in Deno edge environments. Fixed in commit `3f09238`.

This file defines the *authoritative truth* for this repository.
All AI agents (Claude Code, ChatGPT, etc.) must follow these rules before making any assumptions, changes, or recommendations.

---

## ✅ **1. Treat the Repository as Clean and Stable**

- Do **not** assume the repository is broken or corrupted.
- Do **not** suggest rebuilding migrations, deleting directories, or recreating projects unless explicitly asked.
- The codebase is **known-good**, deployed, tested, and stable as of the commit hashes listed below.

---

## ✅ **2. Handle Untracked or Modified Files Safely**

If `git status` shows untracked files:

- FIRST ask:
  > "Is this intentional, or should I add it to .gitignore or remove it?"

- If the user does *not* explicitly say "commit this,"
  → add it to `.gitignore` or clean it up.
- **Never assume new files indicate broken code.**
- **Never remove or alter migrations automatically.**

This prevents accidental deletion of business logic or schema history.

---

## ✅ **3. Calendly Integration: DO NOT MODIFY**

The production Calendly → Supabase → Portal integration is **confirmed working** on `main`.

- Do NOT suggest removing it.
- Do NOT rebuild or redesign it.
- Only modify Calendly logic when the user specifically requests new features or changes.

---

## ✅ **4. Item Status Logic: DO NOT REWRITE**

The correct and intentional state machine is:

```text
home → scheduled → stored
(stored → home on delivery completion)
```

And for editing:
- Adding items → scheduled
- Removing pickup items → home
- Removing delivery items → stored

This state model is correct.
Do NOT change it unless explicitly asked.

---

## ✅ **5. Migrations Are Fully Applied**

Supabase migrations are complete and in sync:
- Latest db commit: `b9a0330`
- All migrations have been applied.
- There are no pending migration files.

Do NOT generate, delete, reorder, or modify migrations unless the user explicitly asks for schema changes.

---

## ✅ **6. Branding Assets Are Correct and Final**

- Header wordmark (600×80 PNG) integrated and sized appropriately.
- Sign-in hero logo (1200×1200 PNG) integrated and tested.
- SVG leftovers were removed intentionally.
- Do NOT regenerate or downscale assets unless asked.

---

## ✅ **7. When Starting a New Session: Follow This Protocol**

Before making ANY changes, run:

```bash
git status
```

Then follow these rules:
1. If there are no changes → proceed normally.
2. If there are changes, ask:
   > "Should these be committed, ignored via .gitignore, or discarded?"
3. Do NOT:
   - Suggest that changes imply broken code
   - Recommend removing migrations
   - Recommend re-initializing repos
   - Suggest that Calendly only works on a feature branch
   - Propose rewrites without user instruction
4. ALWAYS assume system integrity unless explicitly told otherwise.

---

## 🔐 **8. Last Known Good Commits**

Record of last verified stable state:
- **sv-portal/main:** `ed1d218`
- **sv-db/main:** `b9a0330`
- **sv-edge/main:** `3f09238` (Dec 6, 2025 - Stripe webhook fix)

All repos confirmed clean.
Production portal returning 200 OK.
All features verified functional.

---

## ✅ **9. Stripe Webhook: Critical Knowledge**

**Version:** v3.4 (deployed Dec 6, 2025)

**Key Technical Requirements:**
```typescript
// Stripe SDK v17 in Deno requires async verification
const cryptoProvider = Stripe.createSubtleCryptoProvider()
event = await stripe.webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider)
```

**$0 Promo Checkout Behavior:**
- When `amount_total = 0` (100% discount), Stripe does NOT create a customer object
- `session.customer` will be `null` - this is expected
- Users are tracked in Supabase (auth.users + customer_profile), not Stripe
- The webhook handles this gracefully - do NOT require `stripe_customer_id`

**RPC Functions Created (billing schema not exposed via PostgREST):**
- `public.insert_stripe_webhook_event()` - Idempotent event recording
- `public.upsert_billing_customer()` - Billing customer upsert

**DO NOT:**
- Revert to sync `constructEvent()` - it will fail silently
- Require `stripe_customer_id` for profile creation
- Remove the `cryptoProvider` - it's required for edge environments

---

## 🧭 **10. Instructions for Future Claude Code**

If anything seems inconsistent:

> "Pause. Ask Zach for confirmation before touching anything."

- NEVER proactively rewrite or refactor critical systems.
- NEVER assume corruption.
- NEVER rebuild without explicit direction.

---

## 🎯 **Purpose of This Block**

This block ensures:
- Clean session handoffs
- Zero false alarms
- Zero unnecessary rebuilds
- Zero "feature-branch panic"
- A predictable, stable developer experience for Zach and Storage Valet

---

✔️ **End of Protection Block**

(Session-specific notes below this line.)

---

# sv-edge - Storage Valet Edge Functions
**Last Updated:** 2025-11-27
**Critical:** ALL functions must deploy with --no-verify-jwt flag

## 🔴 DEPLOYMENT WARNING
```bash
# NEVER deploy without the flag:
supabase functions deploy [name] --no-verify-jwt

# Or use the script that has correct flags:
./deploy-and-test.sh
```

---

## Project Overview

Storage Valet is a **pick-up-and-store service** for residential customers. This portal is the customer-facing web app for managing inventory, scheduling pickups/deliveries, and account management.

**Tech Stack:**
- Frontend: Vite + React + TypeScript
- Backend: Supabase (Auth, Postgres, Storage, Edge Functions)
- Payments: Stripe Hosted Checkout + Customer Portal
- Deployment: Vercel (portal.mystoragevalet.com)

---

## Current State (Phase 1.0)

### What's Built
✅ Authentication (magic links only)
✅ Dashboard (view items, stats, insurance value)
✅ Item CRUD (create, edit, delete with 1-5 photos)
✅ Batch operations (multi-select pickup/redelivery/containers)
✅ Search & filters (keyword, status, category)
✅ Profile editing (name, phone, address)
✅ Movement history (event timeline per item)
✅ QR codes (print/download for item labels)
✅ Physical lock (prevent edits after pickup confirmation)
✅ RLS security (owner-only access all tables)

### What's Pending
⏳ Manual testing (90+ test cases ready)
⏳ Bug fixes (if any found)
⏳ Production deployment

---

## Architectural Constraints (NON-NEGOTIABLE)

**Hard Rules:**
- **4 routes only:** `/login`, `/dashboard`, `/schedule`, `/account`
- **Supabase backend only** (no Firebase, no custom API server)
- **Stripe Hosted flows only** (no custom card UI, no Stripe Elements)
- **Single pricing tier:** $299/month (one-time setup fee $99, controlled via Stripe promotions)
- **Magic links only** (no password auth)
- **RLS on all tables** (zero cross-tenant access)
- **Private storage bucket** (signed URLs with 1h expiry)
- **Webflow for marketing** (no portal functionality on marketing site)
- **Language: "as needed"** (never say "on-demand")

**Flexible Guidelines (NOT Limits):**
- Keep files organized and clean
- Justify all dependencies
- Maintain security (RLS, signed URLs)
- Test before deploying
- Document major changes

**Lifted Constraints (NO LONGER ENFORCED):**
- ~~<500 LOC core logic~~ → Now ~1,800+ LOC (Phase 1)
- ~~≤12 src files~~ → Now ~22 files (Phase 1)
- ~~≤6 prod deps~~ → Now 8-9 deps (justified additions)

See: `~/code/sv-docs/PHASE_1_STRATEGIC_SHIFT.md` for rationale

---

## Security Patterns (CRITICAL)

### Defense-in-Depth Security Architecture
**As of Migration 0006 (Oct 30, 2024):**

Storage Valet implements **database-enforced security** using PostgreSQL Row Level Security (RLS). Client-side `user_id` filters are **redundant backup** - the database itself prevents cross-tenant access.

#### **Layer 1: Database RLS (Primary Security)**
- **Enabled on all tables:** `customer_profile`, `items`, `actions`, `claims`, `inventory_events`
- **Baseline policies:** Users can only access rows where `user_id = auth.uid()`
- **Service role bypass:** System operations use `service_role` to bypass RLS
- **Performance:** Strategic indexes on `user_id` columns prevent RLS slowdowns

#### **Layer 2: Application Queries (Backup)**
**Client code still filters by `user_id` for clarity and fail-safe:**
```typescript
// ✅ CORRECT - Explicit filter (RLS also enforces this)
const { data } = await supabase
  .from('items')
  .select('*')
  .eq('user_id', user.id);

// ⚠️ WORKS BUT REDUNDANT - RLS prevents cross-tenant access
const { data } = await supabase
  .from('items')
  .select('*')
  .eq('id', itemId);  // RLS policy adds: AND user_id = auth.uid()
```

#### **Layer 3: Billing Field Protection**
Stripe-managed columns (`subscription_status`, `stripe_customer_id`, etc.) are **protected** by:
- **REVOKE UPDATE** from authenticated users (cannot directly modify)
- **SECURITY DEFINER function:** `update_subscription_status()` callable only by service_role
- **Webhook access:** stripe-webhook edge function uses service_role to call RPC

**Impact:** Users cannot set `subscription_status='active'` without paying Stripe.

**RLS Policies Active:**
- `customer_profile` - owner-only SELECT/UPDATE (Stripe fields protected)
- `items` - owner-only full CRUD
- `actions` - owner-only CRUD (pending only), service_role can update confirmed/completed
- `claims` - owner-only SELECT/INSERT, service_role updates status
- `inventory_events` - owner-only SELECT, service_role inserts via system functions
- Storage bucket `item-photos` - owner-only access via signed URLs

### Photo Access
- Bucket: `item-photos` (private)
- Access: Signed URLs only (1h expiry)
- Functions: `getItemPhotoUrl()`, `getItemPhotoUrls()`, `uploadItemPhotos()` in `src/lib/supabase.ts`

### Physical Lock
- Trigger: `prevent_physical_edits_after_pickup()` on `items` table
- Rule: Cannot edit physical dimensions (`weight_lbs`, `length_inches`, `width_inches`, `height_inches`) after `physical_locked_at` is set
- Lock set: After first pickup confirmation (when ops confirms pickup)
- Enforced at: DB level (trigger) + UI validation

---

## Stripe Integration

### Flows
1. **Checkout:** Webflow CTA → Edge Function `create-checkout` → Stripe Hosted Checkout → Success
2. **Portal:** Account page → Edge Function `create-portal-session` → Stripe Hosted Portal
3. **Webhooks:** Stripe → Edge Function `stripe-webhook` → DB update (idempotent via `event_id`)

### Edge Functions
- `create-checkout`: Creates Stripe Checkout session
- `create-portal-session`: Creates Stripe Customer Portal session
- `stripe-webhook`: Handles subscription lifecycle events

**Current Status:** All 3 functions deployed and redeployed Oct 31, 2025

**API Keys (Updated Oct 31, 2025):**
- **Platform-managed:** Edge Functions automatically receive `SUPABASE_SERVICE_ROLE_KEY` from Supabase platform
- **No manual secrets required:** Functions use `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` which is auto-updated when keys rotate
- **Current JWT:** `iat: 1758059308` (issued Oct 31, 2025, 9:00am EDT)
- **Secret key created:** `srv_edge_functions_2025_10` (`sb_secret_RetZFiENHwc2DT9j_FRU8Q__zJALaB`) - reserved for future PostgREST/Storage/RPC use
- **Key limitation:** `sb_secret_...` keys do NOT work for Auth Admin endpoints; use `service_role` JWT for admin operations

**Security Note (Migration 0006):** Webhook uses `update_subscription_status()` RPC to bypass RLS when updating billing fields. Direct UPDATE revoked from authenticated users to prevent fraud.

**Key Rotation History:**
- Oct 11, 2025: Initial JWT keys issued (`iat: 1728697830`)
- Oct 31, 2025: JWT signing secret rotated after service_role key exposure (`iat: 1758059308`)
- Next rotation: Pre-launch (before first paying customer)

---

## Database Schema (Migrations 0001-0006)

**Schemas:**
- `public` - Customer-facing tables
- `billing` - Stripe integration tables

**Tables:**

**`public.customer_profile`** - User account data (RLS enabled)
- `user_id` (PK, references auth.users, NOT NULL)
- `email` (NOT NULL), `stripe_customer_id`, `subscription_id`
- `subscription_status` (ENUM: inactive | active | past_due | canceled, NOT NULL)
- `last_payment_at`, `last_payment_failed_at` (timestamps from webhooks, Migration 0005)
- `full_name`, `phone`, `delivery_address` (jsonb), `delivery_instructions`
- **Security:** Stripe columns protected (REVOKE UPDATE, use `update_subscription_status()` RPC)

**`public.items`** - Customer inventory (RLS enabled)
- `id` (PK), `user_id` (FK, NOT NULL)
- `label` (NOT NULL), `description` (NOT NULL), `category`
- `photo_path` (legacy, nullable), `photo_paths` (text[], 1-5 photos)
- `qr_code` (unique: SV-YYYY-######)
- `status` (ENUM: home | in_transit | stored, NOT NULL, Migration 0006)
- `weight_lbs`, `length_inches`, `width_inches`, `height_inches`
- `physical_locked_at` (timestamp, prevents edits after pickup)
- `cubic_feet`, `created_at`, `updated_at`

**`public.actions`** - Pickup/redelivery/container requests (RLS enabled)
- `id` (PK), `user_id` (FK, NOT NULL)
- `service_type` (NOT NULL: pickup | redelivery | container_delivery)
- `item_ids` (uuid[], for batch operations)
- `scheduled_at`, `created_at`, `updated_at`
- `status` (ENUM: pending | confirmed | completed | canceled, NOT NULL, Migration 0006)
- `details` (jsonb)

**`public.claims`** - Insurance claims (RLS enabled, Migration 0006)
- `id` (PK), `user_id` (FK, NOT NULL), `item_id` (FK, NOT NULL)
- `amount`, `description`, `status` (NOT NULL)
- `created_at`, `updated_at`
- **FK behavior:** item_id ON DELETE RESTRICT (protects against accidental deletion)

**`public.inventory_events`** - Movement history (RLS enabled)
- `id` (PK), `user_id` (FK, NOT NULL), `item_id` (FK, NOT NULL)
- `event_type` (NOT NULL), `event_data` (jsonb), `created_at`
- **FK behavior:** item_id ON DELETE CASCADE (preserves history if item deleted)

**`billing.customers`** - Stripe customer mapping
- `user_id` (PK, FK), `stripe_customer_id`, `created_at`

**`billing.webhook_events`** - Webhook idempotency log
- `id` (PK), `event_id` (UNIQUE, Migration 0006), `event_type`, `payload` (jsonb)
- `processed_at`, `created_at`
- **Security:** UNIQUE constraint prevents duplicate webhook processing

**Key Functions:**
- `update_subscription_status(p_user_id, p_status, ...)` - SECURITY DEFINER, service_role only
- `set_updated_at()` - Trigger function for consistent timestamp management

---

## File Structure

```
~/code/
├── sv-portal/               # React frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── lib/           # Utilities (supabase.ts, queries.ts)
│   │   ├── pages/         # Route pages (4 total)
│   │   ├── types/         # TypeScript types
│   │   └── main.tsx       # Entry point
│   ├── public/            # Static assets
│   └── vercel.json        # SPA routing config
│
├── sv-db/                  # Database migrations
│   ├── migrations/        # SQL migrations (0001-0006)
│   └── scripts/          # Validation scripts
│
├── sv-edge/                # Supabase Edge Functions
│   ├── create-checkout/
│   ├── create-portal-session/
│   └── stripe-webhook/
│
└── sv-docs/                # Documentation
    ├── runbooks/          # Ops guides
    ├── addenda/           # Phase 1 specs
    └── platform-docs/     # Integration guides
```

---

## Autonomous Agent Usage

**⚠️ IMPORTANT: Only use Task tool when user EXPLICITLY requests it.**

**Safe Usage Pattern:**
1. User makes explicit request: "run a security audit", "check with an agent", "use a specialized agent"
2. You ask for confirmation if scope is unclear
3. You invoke Task tool with clear, bounded scope
4. You report results back to user

### When Task Tool May Be Helpful

**Security Audits:**
- User explicitly asks: "run a security audit", "check for security vulnerabilities with an agent"
- Scope: RLS policies, user_id filters, storage access, cross-tenant isolation
- Always confirm with user before invoking

**Documentation Audits:**
- User explicitly asks: "audit docs with an agent", "check if documentation is current"
- Scope: Compare code to docs, find outdated references
- Always confirm with user before invoking

**Code Reviews:**
- User explicitly asks: "review this code with an agent", "comprehensive quality check"
- Scope: Phase 1 completeness, architectural constraints, code quality
- Always confirm with user before invoking

### ❌ DO NOT Auto-Invoke Task Tool

**Never auto-trigger on vague keywords:**
- ❌ User: "check this" → Do NOT invoke Task tool (too vague)
- ❌ User: "review my changes" → Do NOT invoke Task tool (you can review directly)
- ❌ User: "validate" → Do NOT invoke Task tool (do it yourself)
- ❌ User: "are there security issues?" → Do NOT invoke Task tool (answer from context first)

**Only invoke when:**
- ✅ User explicitly says "use an agent", "run [X] with a specialized agent", "Task tool"
- ✅ Task requires searching 50+ files across multiple directories
- ✅ You've asked user to confirm scope first

---

## Common Issues & Solutions

### Photo Upload Fails
- Check: File size <5MB
- Check: Format is `image/jpeg` or `image/png`
- Check: Signed URL not expired (1h limit)
- Solution: See `src/lib/supabase.ts` → `uploadItemPhotos()`

### Users Seeing Each Other's Data
- **Critical:** RLS policy missing or incorrect
- Check: All `SELECT` queries use `user_id = auth.uid()` in RLS policy
- Check: All tables have `ENABLE ROW LEVEL SECURITY`
- Solution: Add/fix RLS policy in migration, test with 2 users

### Webhook 404 Errors
- Check: Edge function `stripe-webhook` deployed
- Check: Stripe webhook URL matches: `https://gmjucacmbrumncfnnhua.supabase.co/functions/v1/stripe-webhook`
- Check: Schema qualification (`billing.customers` not `customers`)
- Solution: Redeploy edge function with correct schema refs

### Physical Lock Not Working
- Check: Trigger `prevent_physical_edits_after_pickup()` exists on `items` table
- Check: `physical_locked_at` column is set (not null) after pickup
- Check: Trying to edit `weight_lbs`, `length_inches`, `width_inches`, or `height_inches`
- Solution: Run migration 0004 if missing trigger

### Item Status Not Updating
- Check: Valid status values: `home`, `in_transit`, `stored`
- Check: Constraint `items_status_check` exists
- Solution: Use exact enum values (lowercase)

---

## Testing Approach

**Manual Test Script:** `~/code/sv-docs/runbooks/PHASE_1_MANUAL_TEST_SCRIPT.md`
- 90+ test cases across 13 sections
- Requires 2 test accounts (User A, User B)
- ~3-5 hours to complete

**Key Test Sections:**
- **Section 5 (Security):** Cross-tenant data access attempts, RLS verification
- **Section 12 (Performance):** 50+ items load time (<5s), concurrent photo uploads
- **Section 7 (Physical Lock):** Verify edits blocked after `physical_locked_at` set

---

## Deployment Process

**Pre-Deploy:**
1. Run manual test script
2. Fix critical/high bugs
3. Run validation checklist (`FINAL_VALIDATION_CHECKLIST_v3.1_PHASE1.md`)
4. Make go/no-go decision

**Deploy:**
1. Backup production DB
2. Apply migration 0004 (`phase1_inventory_enhancements.sql`)
3. Deploy edge functions (all 3)
4. Deploy portal to Vercel
5. Smoke test

**Rollback:**
- Database: Restore from backup
- Code: Revert Vercel deployment
- Edge Functions: Redeploy previous version

---

## Key Documentation

**Must Read:**
- `~/code/sv-docs/PHASE_1_STRATEGIC_SHIFT.md` - Why constraints were lifted
- `~/code/sv-docs/SV_Implementation_Plan_FINAL_v3.1_2025-10-10.md` - Original architecture (note: some constraints outdated, see PHASE_1_STRATEGIC_SHIFT.md)
- `~/code/sv-docs/runbooks/DEPLOYMENT_STATUS_2025-10-24.md` - Current infrastructure state

**Testing:**
- `~/code/sv-docs/runbooks/PHASE_1_MANUAL_TEST_SCRIPT.md` - Test cases
- `~/code/sv-docs/FINAL_VALIDATION_CHECKLIST_v3.1_PHASE1.md` - Validation gates

**Operations:**
- `~/code/sv-docs/runbooks/PRODUCTION_DEPLOYMENT_CHECKLIST.md` - Deploy steps
- `~/code/sv-docs/runbooks/BUG_TRACKING_TEMPLATE.md` - Bug reporting format

---

## Decision Framework

**When adding features, ask:**
1. Does this serve a documented customer need?
2. Is the code clean, tested, and maintainable?
3. Does it maintain security (RLS, signed URLs)?
4. Does it preserve architectural constraints (4 routes, Stripe Hosted)?
5. Can we justify this dependency/complexity?

**If YES to all → Build it cleanly**
**If NO to any → Reconsider or ask user**

---

## Contact & Ownership

- **Product Owner:** Zach Brown
- **Implementation:** Claude Code (AI Assistant)
- **Infrastructure:** Perplexity Agent (Webflow, DNS)
- **Documentation:** `~/code/sv-docs`

---

## Guidelines for AI Agents

**⚠️ CRITICAL: Task Tool Safety**

**DO NOT auto-invoke Task tool based on keywords.** This causes infinite loops and CPU spikes.

**Safe Agent Usage:**
1. **Only invoke Task tool when user explicitly requests it**: "use an agent", "run with Task tool"
2. **Always confirm scope first** if request is ambiguous
3. **Never auto-trigger** on words like "check", "review", "validate", "audit"
4. **You can answer most questions directly** without spawning agents

**Example - WRONG Approach (causes freezing):**
```
User: "Are there any security issues?"
❌ Agent: "I'll run a security audit" → Invokes Task tool → FREEZES
```

**Example - CORRECT Approach:**
```
User: "Are there any security issues?"
✅ Agent: "Let me check the RLS policies and queries directly"
   → Uses Read/Grep tools directly
   → Returns answer without spawning sub-agent
```

**When to offer Task tool (but don't invoke automatically):**
- User asks about codebase-wide patterns across 50+ files
- You suggest: "This would benefit from a specialized agent. Should I use the Task tool?"
- Wait for user confirmation before invoking
