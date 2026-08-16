# Add an Arena ingest adapter

Follow docs/ADAPTER_ONBOARDING.md. A new source is a worker adapter, not an old
connector-class path or a new Vercel fetch route.

## 1. Evidence and product contract

- Identify the exact public leaderboard/profile endpoints and their terms.
- Declare native windows, identity key, timestamps, pagination, units, and every
  metric the source can actually prove.
- Preserve null for unavailable metrics. Do not derive one period from another.
- Record geo/rate-limit constraints without deploying a proxy or infrastructure.

## 2. Implement the worker adapter

- Add the source under lib/ingest/adapters/<source>/.
- Implement the current SourceAdapter contract from lib/ingest/core/adapter.ts.
- Add the registration import to lib/ingest/adapters/register.ts.
- Keep payload parsing in a pure parser module where practical.
- Use lib/ingest/fetch/rate-limiter.ts and the existing bounded fetch helpers.

Private arena schema persistence belongs to the ingest worker boundary. Do not add
PostgREST writes to removed legacy tables or create a per-source cron endpoint.

## 3. Tests

- Add redacted or synthetic fixtures under the adapter **tests**/fixtures directory.
- Test identity mapping, pagination, units, time windows, missing fields, malformed
  payloads, and stale/future observations.
- Prove the adapter registers exactly once and that failures cannot publish a partial cohort.
- Run focused adapter tests, worker typecheck/lint, ingest integration tests, and
  the relevant ranking/publication QA.

## 4. Registry and migration

Any new registry or private schema row must be a reviewed forward migration with an
isolated PG17 proof where SQL semantics matter. Do not edit applied history, apply a
migration, alter worker schedules, deploy, or touch production without explicit
authorization.

## 5. Hand-off

Open a draft PR with source evidence, metric limitations, fixture provenance,
verification commands, and remaining live witnesses. Production onboarding,
credentials, scheduling, and deployment are separate gates.
