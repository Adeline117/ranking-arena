-- Auto-cleanup for stripe_events idempotency table
-- Stripe max retry window is 3 days; we keep 30 days for safety margin.
-- Without this, stripe_events grows unboundedly (~50-100 rows/day).

DROP FUNCTION IF EXISTS cleanup_old_stripe_events() CASCADE;

CREATE FUNCTION cleanup_old_stripe_events()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM stripe_events WHERE processed_at < now() - interval '30 days';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleanup_stripe_events
  AFTER INSERT ON stripe_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_old_stripe_events();
