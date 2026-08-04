# V1 combined integration decisions — 2026-08-04

This branch is an offline integration candidate only. It authorizes no push,
deployment, worker start, migration, production database write, or backup run.

## Frozen inputs

- Base: `046a44d3353e6badac11fcfb34e5bc6d3eb525d4`
- Migration/NFT blockers: `1d6d2d37eb5f27adb9dbf82fec857225417d2e52`
- Backup hardening: `889c88cb97f46efe52d5dab0be239e04deede22e`
- V1 candidate: `5259cb789881e505bd6b5b5776e9e6e2118b3b00`
- Independent token containment reviewed for forward inclusion:
  `5ed4718b67ad78c42fd919dfe1f6508221893916`

## Conflict decisions

1. `.github/workflows/ci.yml`: keep immutable action SHAs and disabled
   production-secret jobs from V1. Run both the latest-main PG17 chain
   (legacy history freeze, resolver/capability hardening, copier publication)
   and the V1 exchange ACL, authorization, portfolio retirement, claim, and
   activation suites.
2. `package.json`: expose every script used by both PG17 gate sets. No command
   from either side was replaced by an alias with weaker coverage.
3. `lib/data/serving/records.ts`: retain latest-main kind-aware sanitization,
   completeness metadata, copier anonymity, and allowlist behavior. Retain the
   V1 `position_history` short-circuit before `arena_records_page`, so a stale
   caller cannot touch PostgREST or receive a cursor.
4. `worker/src/ingest/processors/tier-c-profile.ts`: both `copiers` and
   `position_history` start with a null legacy cursor. Copier capture keeps the
   receipt-bound snapshot publication path; position history remains RAW-only.
5. `scripts/qa/ingest-serving-writer-boundary.test.mjs`: combine canonical and
   dynamic position-history DML detection, zero-allowlist legacy public-history
   reads/writes, direct legacy copier-writer detection, and the narrower actual
   generic publisher caller inventory. The manual copier smoke must use the
   receipt-bound artifact/publication path and cannot include position history.
6. `scripts/maintenance/backup-to-r2.mjs` and its tests: retain the newer
   shell-free producer, scrubbed `PGDATABASE`, producer-exit gate, minimum
   application relation check, no automatic retention deletion, and partial
   cleanup. Also retain the V1 private per-run workspace, immutable upload/HEAD
   split, and workspace cleanup. The older shell pipeline and automatic prune
   implementation are intentionally rejected.
7. `docs/RUNBOOK.md`: the current incident remains NO-GO. Preserve V1's
   domain-wide token containment, full predeploy/ledger proof, exact-SHA bridge,
   two-network/cache evidence, and phased Claim/Portfolio sequence. Extend its
   ordered database gate with latest-main `040440` through `040540` migrations
   and their read-only SQL proofs. No runbook text grants production execution.
8. Token containment is not present in the V1 candidate commit, so the
   independent production-exact containment change is forward-included. Its
   API, pages, navigation, sitemap, containment module, checker, and tests are
   byte-identical to `5ed4718b6`; only the four i18n dictionaries also retain
   newer main/V1 translations. This prevents a future V1 deployment from
   reopening the retired token surface.
9. The six latest-main `040440`–`040540` migration files raise the immutable
   history-shape ratchet from 588/397 total/modern entries to 594/403. Legacy
   debt counts and hashes remain unchanged.

## Verification boundary

The branch is accepted only after conflict-marker/diff checks, focused backup,
writer-boundary, records/Tier-C, migration/NFT and token-containment tests,
application and worker type checks, and the relevant offline QA contracts pass.
Production/staging database execution remains a separate explicit gate.

The clean offline candidate validation completed with the following evidence:

- Node 22.23.2 clean install from lockfile SHA-256
  `c60a9fddee366d056b6b60525867c356c9f241846575396fe7595261700db609`;
  exact `@lhci/cli` 0.15.1 and overridden `tmp` 0.2.7.
- `npm audit --audit-level=high`: zero high and zero critical findings (2 low,
  23 moderate remain and are not silently auto-fixed).
- 278/278 offline QA contracts and all 18 PostgreSQL 17 gate groups passed.
- Full Jest coverage with Redis 7.4.9 and a reproducible two-worker budget:
  1084 suites passed, 2 skipped; 12334 tests passed, 17 skipped.
- Next.js 16.2.11 production-like build passed, including 161 static pages and
  the postbuild BigInt scan across 1094 browser chunks. Later candidate changes
  affect only workflows, QA, documentation, and a dev-only Lighthouse package;
  the exact PR commit must still pass the hosted Build job.
- Private Lighthouse collection made nine runs across `/`, `/methodology`, and
  `/about`. Minimum per-page performance was 0.84/0.98/0.96, accessibility
  0.96/0.99/0.96, best-practices 0.96 for all pages, and HTTP-status 1.0 for
  every run. Reports stayed on the validation host.

The migration lint now derives the exact PR merge-base or push before/after
state, scans committed regular blobs, handles renames and root/non-fast-forward
pushes, rejects malformed SQL, and conservatively detects destructive DDL in
quoted executable bodies. Its 19 focused tests include the previous semicolon
inside a quoted default `SET NOT NULL` false-negative.

## Current CI interpretation

- Frozen main `046a44d33` was blocked by the `brace-expansion`
  GHSA-rgw5-rvv9-x895 dependency finding. The combined tree contains the
  byte-identical `5.0.8` -> `5.0.9` compatibility facade and lockfile fix; clean
  install, compatibility tests, and the zero-high/critical audit now pass.
- `types-live` failures caused by missing Actions `DATABASE_URL`,
  `SUPABASE_SECRET_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are credential-context
  failures. This branch retains V1's explicit disabled/fail-closed
  production-secret jobs; it does not weaken them to make CI green.
- The earlier Playwright smoke itself passed while artifact upload failed from
  storage quota. A read-only inventory now shows only about 266.7 MB across 252
  unexpired artifacts; 1727 expired records account for about 87.93 GB of the
  nominal API total. Combined PR jobs do not upload those heavy artifacts, so
  PR execution is unblocked, while quota reclamation remains an operational
  follow-up rather than a reason to delete release evidence during this change.
- PR 253 has six real conflicts with main and is superseded for integration
  review by this combined branch after the `5ed4718b6` containment forward-port.

## Production read-only catalogue freeze

At `2026-08-04T19:15:53.362Z`, production was inventoried read-only before any
migration planning. No database write or migration was performed.

- Functions: 396; SHA-256
  `393a49396f9ebaf261df4f61ec979d62e2ab2af3608e3627bdc9cebbfca1ad79`
- Tables: 197; SHA-256
  `d72712a1b991ebd0070d1012e82c23f79d212b30fc722a814a92e97256a23276`
- Columns (197 tables): SHA-256
  `4ea4554a58ef626c31328e941d4b3c692a91c6e30529a4536f0cc1b90077d304`
- Migration ledger: 546 entries; SHA-256
  `7d7b7a1ef44d412665383ede22877c577f29641a9986718491f620ca9ce03e31`
- Full inventory: SHA-256
  `34e627455ce0b3ba7a663e5004526088d5b81c51fae30f6711df3a3d71eee2d0`

The live schema contract is missing exactly five required RPCs:
`get_popular_tokens_v2`, `get_token_ranking_publication_head`,
`get_token_trader_rankings_v2`,
`refresh_public_rank_count_cache_for_seasons`, and
`rerank_public_eligible_leaderboard`. Migration QA also reports 101 repository
filename candidates absent from the live ledger. That count is advisory: many
files are renamed or already have equivalent live effects, so it is not an
authorization to batch-apply 101 migrations. Each candidate must be reconciled
against the frozen catalogue and then proved on disposable PostgreSQL 17.

## Recovery rehearsal evidence

The 5,112,388,073-byte 2026-07-26 legacy object and its server-side incident
hold have matching sizes and ETags. A direct streamed restore into isolated
PostgreSQL 17.8 produced 345 user tables and positive critical-table counts,
including `arena.traders=217938`, `arena.trader_stats=552870`, and
`public.leaderboard_ranks=41760`. This disproves the earlier inference that the
object lacked leaderboard rows.

The rehearsal was deliberately terminated after 880 seconds when the partial
database reached about 22 GB and the remote disk fell to 8.2 GiB free. It was
still in `COPY public.tph_2026_05`; data loading, indexes, full stream CRC/tail,
RLS/auth and application smoke were therefore incomplete. The disposable
partial database was dropped, while the R2 source and
`incident-hold/2026-08-04/arena-backup-20260726-schemas.sql.gz` remain intact.
Full certification requires a managed PostgreSQL 17 scratch target with at
least about 100 GiB free and remains a release blocker.
