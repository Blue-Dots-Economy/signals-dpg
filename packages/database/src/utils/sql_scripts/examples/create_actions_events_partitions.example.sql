-- Example network/action partitions.
-- Run `create_actions_events.sql` first.

DO $$
BEGIN
  IF to_regclass('public.item_actions') IS NULL THEN
    RAISE EXCEPTION 'Parent table "item_actions" does not exist.';
  END IF;
  IF to_regclass('public.action_events') IS NULL THEN
    RAISE EXCEPTION 'Parent table "action_events" does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS a_p_yellowdot
PARTITION OF item_actions
FOR VALUES IN ('yellow_dot')
PARTITION BY LIST (action_type);

CREATE TABLE IF NOT EXISTS a_p_yellowdot_connect
PARTITION OF a_p_yellowdot
FOR VALUES IN ('connect');

CREATE TABLE IF NOT EXISTS e_p_yellowdot
PARTITION OF action_events
FOR VALUES IN ('yellow_dot')
PARTITION BY LIST (action_type);

CREATE TABLE IF NOT EXISTS e_p_yellowdot_connect
PARTITION OF e_p_yellowdot
FOR VALUES IN ('connect');
