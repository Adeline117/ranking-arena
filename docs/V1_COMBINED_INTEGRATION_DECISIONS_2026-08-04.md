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

## Verification boundary

The branch is accepted only after conflict-marker/diff checks, focused backup,
writer-boundary, records/Tier-C, migration/NFT and token-containment tests,
application and worker type checks, and the relevant offline QA contracts pass.
Production/staging database execution remains a separate explicit gate.
