# Add XXX Exchange Ingest Source

## Context

Add XXX exchange leaderboard data through the registry-driven ingest worker.
Follow `docs/ADAPTER_ONBOARDING.md`; this template does not authorize a new
Vercel fetch loop or standalone connector registry.

## Acceptance Criteria

- [ ] Capture and document the upstream leaderboard/profile surfaces and geo requirements.
- [ ] Add a `lib/ingest/adapters/<source>/` module with pure parsers and declared capabilities.
- [ ] Store representative real RAW fixtures and cover every declared metric with parser tests.
- [ ] Register the adapter in `lib/ingest/adapters/register.ts`.
- [ ] Add expected-metric and parity coverage, including source-specific overrides when needed.
- [ ] Add the `arena.sources` seed through a forward migration created by `scripts/new-migration.sh`.
- [ ] Verify Tier-A publication, serving visibility, freshness, and metric/render coverage.
- [ ] `npm run qa:architecture`, type checks, tests, lint, and production build pass.

## Constraints

- Preserve upstream nulls; do not invent CEX metrics.
- Network access belongs in the adapter fetch boundary; parsers stay free of network, clock,
  and module-state dependencies.
- The database registry owns activation and cadence.
- Do not edit an applied migration.

## Out of Scope

- Historical backfill, unless separately approved with a bounded operator plan.
- Product UI changes unrelated to source visibility.
