# Pending Scripts Confirmation (2026-02-22)

Scope:
- scripts/import/check_comprehensive.mjs
- scripts/import/check_seasons.mjs
- scripts/import/check_status.mjs
- scripts/import/check_all_platforms.mjs
- scripts/import/check_freshness.mjs
- scripts/verify/check-db.mjs
- scripts/check_tables.mjs
- scripts/check_enrichment.mjs

## Confirmation Result Table

| Script | Purpose (confirmed) | Recent usage signal | Smoke result | Recommendation | Risk |
|---|---|---|---|---|---|
| `scripts/import/check_comprehensive.mjs` | Read-only summary of `trader_snapshots` by season/source | Git touch in refactor commit `b110c64a`; no package/cron binding | ✅ Runs and returns real data | **Keep** (manual ops diagnostics) | Low |
| `scripts/import/check_seasons.mjs` | Read-only season/source count check for snapshots | Git touch in `b110c64a`; no package/cron binding | ✅ Runs and returns data | **Keep (needs owner decision later)** | Low |
| `scripts/import/check_status.mjs` | Focused data completeness check (hardcoded sources + time window) | Git touch in `b110c64a`; no package/cron binding | ✅ Runs and returns data | **Keep (likely ad-hoc, but still useful)** | Medium (hardcoded date/window) |
| `scripts/import/check_all_platforms.mjs` | Platform completeness report for 30D snapshots | Mentioned in `scripts/import/ENHANCED_DATA_STATUS.md`; git touch in `b110c64a` | ✅ Runs and returns data | **Keep** | Low |
| `scripts/import/check_freshness.mjs` | Fresh/stale/missing data report for configured sources | Git touch in `b110c64a`; no package/cron binding | ✅ Runs and returns data | **Keep** | Low |
| `scripts/verify/check-db.mjs` | Legacy Bybit migration-era DB inspection; includes hardcoded service-role key | No package/cron/docs references; last commit `6581a9e4` (migration helper context) | ✅ Runs, but tied to legacy table checks | **Archive** to `scripts/_archive/confirmed-unused/` (done) | **High** (embedded secret + legacy scope) |
| `scripts/check_tables.mjs` | Generic DB table/data introspection | Git touch in `6954db87`; no package/cron refs | ⚠️ Partially works; throws `supabase.rpc(...).catch is not a function` | **Keep (needs fix/owner decision)** | Medium |
| `scripts/check_enrichment.mjs` | Enrichment table fill-rate validation | Referenced in `scripts/README.md` | ✅ Runs and outputs fill-rate stats | **Keep** | Low |

## Executed low-risk action

- Archived:
  - `scripts/verify/check-db.mjs` → `scripts/_archive/confirmed-unused/verify/check-db.mjs`

Reason:
- Not wired to package/cron/docs flow.
- Legacy one-off migration helper.
- Contains hardcoded service-role key (high accidental exposure risk if left in active scripts path).

## Notes

- No core business logic/UI changed.
- No production key/config file edits.
- For uncertain scripts, kept and explicitly marked.
