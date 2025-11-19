-- Portal Item Selection Flow - Test Queries
-- Run these in Supabase Dashboard SQL Editor
-- Test User: test.calendly@mystoragevalet.com (user_id: 62a2977f-4c97-4b85-89fe-34925f3277f9)

-- 1. Check if test user has items to select
SELECT
  id,
  label,
  status,
  category,
  created_at
FROM items
WHERE user_id = '62a2977f-4c97-4b85-89fe-34925f3277f9'
ORDER BY created_at DESC;

-- 2. Check current action/booking status
SELECT
  id,
  service_type,
  status,
  scheduled_start,
  scheduled_end,
  calendly_event_uri,
  pickup_item_ids,
  delivery_item_ids,
  created_at
FROM actions
WHERE user_id = '62a2977f-4c97-4b85-89fe-34925f3277f9'
ORDER BY created_at DESC;

-- 3. Check booking events for the test action
SELECT
  id,
  action_id,
  event_type,
  metadata,
  created_at
FROM booking_events
WHERE action_id = '14bd5409-572c-48e3-9f48-cb7ebebc1920'
ORDER BY created_at ASC;

-- 4. Create test items if none exist (status='home' for pickup)
INSERT INTO items (user_id, label, description, category, status)
VALUES
  ('62a2977f-4c97-4b85-89fe-34925f3277f9', 'Test Box 1', 'Test item at home for pickup', 'box', 'home'),
  ('62a2977f-4c97-4b85-89fe-34925f3277f9', 'Test Box 2', 'Test item at home for pickup', 'box', 'home'),
  ('62a2977f-4c97-4b85-89fe-34925f3277f9', 'Test Furniture 1', 'Test furniture at home', 'furniture', 'home')
ON CONFLICT (id) DO NOTHING
RETURNING id, label, status;

-- 5. Create test items with status='stored' (for delivery)
INSERT INTO items (user_id, label, description, category, status)
VALUES
  ('62a2977f-4c97-4b85-89fe-34925f3277f9', 'Stored Box 1', 'Test item in storage for delivery', 'box', 'stored'),
  ('62a2977f-4c97-4b85-89fe-34925f3277f9', 'Stored Box 2', 'Test item in storage for delivery', 'box', 'stored')
ON CONFLICT (id) DO NOTHING
RETURNING id, label, status;

-- 6. Validation query: Check action after item selection
-- Run this AFTER completing item selection in portal
SELECT
  a.id,
  a.service_type,
  a.status,
  a.pickup_item_ids,
  a.delivery_item_ids,
  array_length(a.pickup_item_ids, 1) as pickup_count,
  array_length(a.delivery_item_ids, 1) as delivery_count
FROM actions a
WHERE a.id = '14bd5409-572c-48e3-9f48-cb7ebebc1920';

-- 7. Validation query: Check booking events after item selection
SELECT
  event_type,
  metadata,
  created_at
FROM booking_events
WHERE action_id = '14bd5409-572c-48e3-9f48-cb7ebebc1920'
ORDER BY created_at DESC
LIMIT 5;
