-- Migration: make trader alerts account-specific
--
-- `source_trader_id` is only unique within an exchange. The old
-- UNIQUE(user_id, trader_id) constraint caused an alert configured from one
-- exchange profile to overwrite an alert for the same ID on another exchange.
-- Preserve existing rows, then make source part of the identity. NULLS NOT
-- DISTINCT keeps the legacy no-source path at one row per user/trader too.

DO $$
DECLARE
  legacy_constraint text;
BEGIN
  SELECT c.conname
    INTO legacy_constraint
  FROM pg_constraint c
  WHERE c.conrelid = 'public.trader_alerts'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY k.ordinality)
      FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = k.attnum
    ) = ARRAY['user_id', 'trader_id'];

  IF legacy_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.trader_alerts DROP CONSTRAINT %I',
      legacy_constraint
    );
  END IF;
END $$;

ALTER TABLE public.trader_alerts
  ADD CONSTRAINT trader_alerts_user_trader_source_key
  UNIQUE NULLS NOT DISTINCT (user_id, trader_id, source);

COMMENT ON CONSTRAINT trader_alerts_user_trader_source_key ON public.trader_alerts IS
  'One alert configuration per user and exchange-specific trader account.';
