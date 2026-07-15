-- Verified Data is earned only after Arena has independently confirmed that
-- the exchange credential is read-only. Existing rows remain unverified until
-- the owner reconnects with a key whose permissions can be inspected.

ALTER TABLE public.trader_authorizations
  ADD COLUMN IF NOT EXISTS read_only_verified_at timestamptz;

CREATE INDEX IF NOT EXISTS trader_authorizations_verified_data_idx
  ON public.trader_authorizations (platform, trader_id, last_sync_at DESC)
  WHERE status = 'active'
    AND read_only_verified_at IS NOT NULL
    AND last_sync_status = 'success';

COMMENT ON COLUMN public.trader_authorizations.read_only_verified_at IS
  'When the exchange API itself proved trading, withdrawal, and transfer permissions were disabled.';

-- A badge is not earned merely because a sync job returned successfully. All
-- three first-party windows must have reached the public ranking table after
-- the corresponding first-party stat was published; otherwise the UI could
-- put a Verified mark beside an older scraped number during compute lag.
CREATE OR REPLACE VIEW public.verified_data_authorizations
WITH (security_barrier = true) AS
SELECT DISTINCT a.id AS authorization_id, a.platform, a.trader_id, a.last_sync_at
  FROM public.trader_authorizations a
  JOIN arena.sources s
    ON COALESCE(s.meta->>'legacy_platform', s.slug) = a.platform
  JOIN arena.traders t
    ON t.source_id = s.id AND t.exchange_trader_id = a.trader_id
 WHERE a.status = 'active'
   AND a.read_only_verified_at IS NOT NULL
   AND a.last_sync_status = 'success'
   AND a.last_sync_at > now() - interval '48 hours'
   AND (
     SELECT count(DISTINCT st.timeframe)
       FROM arena.trader_stats st
       JOIN public.leaderboard_ranks lr
         ON lr.source = a.platform
        AND lr.source_trader_id = a.trader_id
        AND lr.season_id = st.timeframe::text || 'D'
        AND lr.computed_at >= st.as_of
      WHERE st.trader_id = t.id
        AND st.timeframe IN (7, 30, 90)
        AND st.extras->>'provenance' = 'first_party'
        AND st.as_of > now() - interval '48 hours'
   ) = 3;

REVOKE ALL ON public.verified_data_authorizations FROM anon, authenticated, public;
GRANT SELECT ON public.verified_data_authorizations TO service_role;
