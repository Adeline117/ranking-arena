# Arena Supabase Operations

Production-safe database workflow for Arena. The `arena` schema is the
authoritative ingest domain; selected `public` tables/RPCs are serving and
compatibility contracts.

## Safety rules

- Start with read-only inspection and never print connection strings or keys.
- Applied files under `supabase/migrations/` are immutable. Add a new timestamped
  forward migration with `scripts/new-migration.sh <description>`.
- Do not hand-write acquisition rows, timestamps, scores, fetch attempts, RAW
  evidence, or publication proofs. Those writes belong to the fenced ingest worker.
- Do not use `now()` or score `computed_at` as upstream freshness.
- Regenerate and verify database types after schema changes; do not bypass missing
  types with raw SQL merely to hide drift.

## Authoritative surfaces

- `arena.sources`: source lifecycle, region, cadence, serving mode, metadata.
- `arena.fetch_attempts` and RAW manifests: acquisition evidence and terminal state.
- `arena.leaderboard_snapshots`: validated source observations.
- `arena.trader_stats`: normalized metric authority.
- `leaderboard_ranks`: public published ranking projection.
- `public.get_platform_freshness()`: active-source fetch freshness, including
  active sources that have never produced a snapshot.

## Read-only diagnostics

```sql
SELECT * FROM public.get_platform_freshness() ORDER BY source;

SELECT slug, status, serving_mode, fetch_region,
       cadence_tier_a, cadence_tier_b, cadence_tier_d
FROM arena.sources
ORDER BY slug;

SELECT source_id, status, started_at, finished_at, error_code
FROM arena.fetch_attempts
ORDER BY started_at DESC
LIMIT 100;
```

Use `/api/admin/monitoring/arena-pipeline` when the required evidence is already
available through the authenticated monitoring API.

## Migration workflow

1. Inspect current generated types and the latest migrations.
2. Create one forward-only migration; make it transactional and idempotent where
   the operation permits.
3. Add a migration contract test for grants, constraints, ownership, or function
   semantics that matter to the application.
4. Run migration-history QA, type generation/check, relevant tests, and a local
   database reset when the environment supports it.
5. Deploy sequentially. Never reorder or edit production migration history to
   make a preview branch pass.

## RLS and privileges

- `anon` and `authenticated` receive only intentionally public/user-scoped access.
- `service_role` is server-only and is not a substitute for missing RLS design.
- Security-definer functions require an explicit `search_path`, least-privilege
  grants, and tests for unauthorized callers.
