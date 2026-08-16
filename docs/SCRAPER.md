# Arena Source Acquisition — V1 Operating Boundary

This guide describes the checked-in source-acquisition architecture and the safe
investigation boundary. It is not a runbook for invoking production fetches,
restarting workers, or changing source routing.

## Current boundary

Arena's current acquisition path is source-driven:

- source identity and region assignment live in the versioned `arena.sources` model
- adapters register through [`lib/ingest/adapters/register.ts`](../lib/ingest/adapters/register.ts)
- request/capture behavior lives under [`lib/ingest/fetch/`](../lib/ingest/fetch/)
- worker orchestration and publication checks live under [`worker/src/ingest/`](../worker/src/ingest/)

Source-specific routing, browser channels, proxies, and worker credentials are
managed configuration. They are not stable public endpoints and must not be copied
into documentation, shell commands, fixtures, or pull requests.

## V1 NO-GO

Until the recorded V1 release gates are satisfied, do not:

- SSH to or restart a worker
- call a private proxy or raw worker endpoint
- invoke a production cron or manually fetch a source
- change source routing, credentials, schedules, database rows, or cached data
- use a successful scrape or row count as publication/freshness proof

These actions require a separately reviewed plan, explicit owner authorization, and
the applicable source, database, and release witnesses.

## Read-only observation

Use the public serving contracts first:

```bash
npm run check:status
npm run check:freshness
npm run check:platforms
```

Record the commit/release identity, observation time, source, and exact failed
contract. A missing worker heartbeat, source witness, or managed credential channel
is an unknown state—not a healthy result.

`npm run check:seasons` and `npm run check:enrichment` are credentialed, read-only
inventories. They fail closed on configuration or query errors, but do not prove
freshness, exact cohort membership, or authority to publish a metric.

## Safe engineering workflow

1. Locate the existing source adapter and registry entry before proposing a change.
2. Reproduce parser behavior with an approved redacted capture or deterministic
   fixture. Never paste a private response, credential, proxy URL, or worker address
   into the repository.
3. Add or adjust focused tests around the adapter/fetch boundary.
4. Keep source acquisition, persistence, and publication changes in a reviewed
   branch/PR. Do not use an ad-hoc cron call as a test.
5. For a real production incident, record the gate and escalate through the approved
   owner/operations channel; this document intentionally contains no restart or
   remote-execution recipe.

## Current references

| Concern                     | Checked-in reference                          |
| --------------------------- | --------------------------------------------- |
| Adapter registration        | `lib/ingest/adapters/register.ts`             |
| Fetch/capture contracts     | `lib/ingest/fetch/`                           |
| Source region handling      | `worker/src/ingest/` and the versioned schema |
| Read-only serving diagnosis | `scripts/check_status.mjs`                    |
| Ranking freshness authority | `npm run check:freshness`                     |
| Public platform coverage    | `npm run check:platforms`                     |

When the V1 NO-GO is lifted, a new approved runbook must be written from the live,
reviewed deployment and source configuration. This historical guide must not be
treated as a substitute for that evidence.
