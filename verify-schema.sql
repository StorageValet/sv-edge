-- Storage Valet - Schema Verification Queries
-- Run these to verify migrations 0011-0013 were applied correctly
-- Expected: User confirmed schema is correct, all queries should return rows/true

-- ============================================================================
-- PART 1: Verify customer_profile columns (Migration 0011)
-- ============================================================================

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'customer_profile'
AND column_name IN ('out_of_service_area', 'needs_manual_refund', 'delivery_instructions')
ORDER BY column_name;
-- Expected: 3 rows

-- ============================================================================
-- PART 2: Verify customer_profile indexes (Migration 0011)
-- ============================================================================

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'customer_profile'
AND indexname IN ('idx_customer_profile_email', 'idx_customer_profile_zip');
-- Expected: 2 rows

-- ============================================================================
-- PART 3: Verify customer_profile constraint (Migration 0011)
-- ============================================================================

SELECT conname, pg_get_constraintdef(oid) as definition
FROM pg_constraint
WHERE conname = 'chk_manual_refund_requires_out_of_area';
-- Expected: 1 row with CHECK constraint

-- ============================================================================
-- PART 4: Verify actions columns (Migration 0012)
-- ============================================================================

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'actions'
AND column_name IN (
  'calendly_event_uri', 'scheduled_end', 'calendly_payload',
  'pickup_item_ids', 'delivery_item_ids', 'service_address'
)
ORDER BY column_name;
-- Expected: 6 rows

-- ============================================================================
-- PART 5: Verify action_status enum values (Migration 0012)
-- ============================================================================

SELECT enumlabel
FROM pg_enum
WHERE enumtypid = (
  SELECT oid FROM pg_type WHERE typname = 'action_status'
)
ORDER BY enumlabel;
-- Expected: pending_items, pending_confirmation, in_progress, confirmed, completed, canceled

-- ============================================================================
-- PART 6: Verify actions indexes (Migration 0012)
-- ============================================================================

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'actions'
AND indexname IN (
  'ux_actions_calendly_event_uri',
  'idx_actions_user_status',
  'idx_actions_pickup_items_gin',
  'idx_actions_delivery_items_gin'
);
-- Expected: 4 rows

-- ============================================================================
-- PART 7: Verify booking_events table exists (Migration 0013)
-- ============================================================================

SELECT EXISTS (
  SELECT FROM information_schema.tables
  WHERE table_name = 'booking_events'
  AND table_schema = 'public'
) as booking_events_exists;
-- Expected: true

-- ============================================================================
-- PART 8: Verify booking_events columns (Migration 0013)
-- ============================================================================

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'booking_events'
ORDER BY ordinal_position;
-- Expected: id, action_id, event_type, metadata, created_at

-- ============================================================================
-- PART 9: Verify booking_events indexes (Migration 0013)
-- ============================================================================

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'booking_events'
AND indexname IN ('idx_booking_events_action_id', 'idx_booking_events_type_created');
-- Expected: 2 rows

-- ============================================================================
-- PART 10: Verify booking_events RLS enabled (Migration 0013)
-- ============================================================================

SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'booking_events'
AND schemaname = 'public';
-- Expected: 1 row with rowsecurity = true

-- ============================================================================
-- PART 11: Verify log_booking_event function exists (Migration 0013)
-- ============================================================================

SELECT EXISTS (
  SELECT FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
  AND p.proname = 'log_booking_event'
) as log_booking_event_exists;
-- Expected: true

-- ============================================================================
-- PART 12: Verify log_booking_event function signature (Migration 0013)
-- ============================================================================

SELECT
  p.proname as function_name,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_functiondef(p.oid) LIKE '%SECURITY DEFINER%' as is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND p.proname = 'log_booking_event';
-- Expected: 1 row with is_security_definer = true

-- ============================================================================
-- SUMMARY QUERY
-- ============================================================================

SELECT
  'customer_profile columns' as check_name,
  COUNT(*) as found,
  3 as expected
FROM information_schema.columns
WHERE table_name = 'customer_profile'
AND column_name IN ('out_of_service_area', 'needs_manual_refund', 'delivery_instructions')

UNION ALL

SELECT
  'actions columns',
  COUNT(*),
  6
FROM information_schema.columns
WHERE table_name = 'actions'
AND column_name IN (
  'calendly_event_uri', 'scheduled_end', 'calendly_payload',
  'pickup_item_ids', 'delivery_item_ids', 'service_address'
)

UNION ALL

SELECT
  'booking_events table',
  CASE WHEN EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_name = 'booking_events'
  ) THEN 1 ELSE 0 END,
  1

UNION ALL

SELECT
  'log_booking_event function',
  CASE WHEN EXISTS (
    SELECT FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'log_booking_event'
  ) THEN 1 ELSE 0 END,
  1;

-- Expected: All rows should have found = expected
