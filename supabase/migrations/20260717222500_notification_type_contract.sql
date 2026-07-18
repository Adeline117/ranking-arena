-- Keep the database notification enum aligned with every application producer.
-- Historical single-column type checks are converged so a stale extra check
-- cannot keep rejecting a newly supported notification after this migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('notification-type-contract', 0)
);

DO $required_objects$
DECLARE
  v_relation pg_catalog.regclass :=
    pg_catalog.to_regclass('public.notifications');
BEGIN
  IF v_relation IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE relation.oid = v_relation
      AND relation.relkind IN ('r', 'p')
      AND owner_role.rolname = 'postgres'
  ) THEN
    RAISE EXCEPTION
      'public.notifications must be a postgres-owned table';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'type'
      AND attribute.atttypid = 'text'::pg_catalog.regtype
      AND attribute.atttypmod = -1
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'public.notifications.type must be unbounded text NOT NULL';
  END IF;
END
$required_objects$;

LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_allowed_types constant text[] := ARRAY[
    'follow',
    'like',
    'reaction',
    'comment',
    'system',
    'mention',
    'copy_trade',
    'message',
    'trader_alert',
    'trader_alert_roi',
    'trader_alert_drawdown',
    'trader_alert_score',
    'trader_alert_pnl',
    'trader_alert_rank',
    'post_reply',
    'new_follower',
    'group_update',
    'ranking_change',
    'referral_reward',
    'tip_received',
    'subscription_expiring',
    'subscription_expired',
    'nft_expired',
    'nft_pending',
    'nft_minted'
  ]::text[];
  v_type_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.notifications'::pg_catalog.regclass
      AND attribute.attname = 'type'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  );
  v_unknown_types text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.conname = 'notifications_type_check'
      AND (
        constraint_row.contype <> 'c'
        OR constraint_row.conkey IS DISTINCT FROM
          ARRAY[v_type_attnum]::smallint[]
      )
  ) THEN
    RAISE EXCEPTION
      'notifications_type_check name collision was preserved';
  END IF;

  SELECT pg_catalog.array_agg(
    DISTINCT notification.type
    ORDER BY notification.type
  )
  INTO v_unknown_types
  FROM public.notifications AS notification
  WHERE NOT (notification.type = ANY(v_allowed_types));

  IF v_unknown_types IS NOT NULL THEN
    RAISE EXCEPTION
      'unknown persisted notification types must be classified first: %',
      v_unknown_types;
  END IF;
END
$preflight$;

DO $drop_stale_type_checks$
DECLARE
  v_constraint_name name;
  v_type_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.notifications'::pg_catalog.regclass
      AND attribute.attname = 'type'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  );
BEGIN
  FOR v_constraint_name IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey =
        ARRAY[v_type_attnum]::smallint[]
    ORDER BY constraint_row.conname
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.notifications DROP CONSTRAINT %I',
      v_constraint_name
    );
  END LOOP;
END
$drop_stale_type_checks$;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN (
      'follow',
      'like',
      'reaction',
      'comment',
      'system',
      'mention',
      'copy_trade',
      'message',
      'trader_alert',
      'trader_alert_roi',
      'trader_alert_drawdown',
      'trader_alert_score',
      'trader_alert_pnl',
      'trader_alert_rank',
      'post_reply',
      'new_follower',
      'group_update',
      'ranking_change',
      'referral_reward',
      'tip_received',
      'subscription_expiring',
      'subscription_expired',
      'nft_expired',
      'nft_pending',
      'nft_minted'
    )
  ) NOT VALID;
ALTER TABLE public.notifications
  VALIDATE CONSTRAINT notifications_type_check;

DO $postflight$
DECLARE
  v_allowed_types constant text[] := ARRAY[
    'follow',
    'like',
    'reaction',
    'comment',
    'system',
    'mention',
    'copy_trade',
    'message',
    'trader_alert',
    'trader_alert_roi',
    'trader_alert_drawdown',
    'trader_alert_score',
    'trader_alert_pnl',
    'trader_alert_rank',
    'post_reply',
    'new_follower',
    'group_update',
    'ranking_change',
    'referral_reward',
    'tip_received',
    'subscription_expiring',
    'subscription_expired',
    'nft_expired',
    'nft_pending',
    'nft_minted'
  ]::text[];
  v_type_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.notifications'::pg_catalog.regclass
      AND attribute.attname = 'type'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  );
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey =
        ARRAY[v_type_attnum]::smallint[]
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.conname = 'notifications_type_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND constraint_row.conkey =
        ARRAY[v_type_attnum]::smallint[]
      AND pg_catalog.md5(
        pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid
        )
      ) = '4202c98e274ce25029f78eefd1beedcd'
  ) THEN
    RAISE EXCEPTION
      'notification type CHECK contract did not converge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.notifications AS notification
    WHERE NOT (notification.type = ANY(v_allowed_types))
  ) THEN
    RAISE EXCEPTION
      'persisted notifications violate the type contract';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
