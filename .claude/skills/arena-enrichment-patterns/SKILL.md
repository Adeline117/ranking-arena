# Arena Enrichment Patterns

Use evidence-first enrichment. Missing data stays null; do not fabricate or infer a
metric from an unrelated period, table, or identity.

## Discover the current path

Old notes and filenames are not authority. Before proposing a change:

```bash
rg -n "source_name|metric_name" worker app lib scripts
rg --files worker app lib scripts | rg "source_name|metric_name"
```

Confirm the referenced file exists and is reachable from a current schedule or
worker. Check public relations against generated types; check private arena
relations against versioned migrations and the worker database boundary. Do not run
a guessed import script.

When approved read-only application access is available, the canonical freshness
inspection surface is `/api/admin/data-freshness`. Retired monitoring contracts
and legacy snapshot timestamps are not freshness authority.

## Evidence and identity rules

- Bind every metric to the exact source identity, season/window, observation time,
  and upstream evidence used to calculate it.
- Preserve null when the upstream payload cannot prove the metric.
- Reject stale or future-dated enrichment rather than carrying it into a new cohort.
- Do not combine periodless history with 7D, 30D, or 90D ranking rows.
- trader_daily_snapshots is quarantined legacy inventory and cannot support
  Sharpe, Sortino, profit factor, equity, indicators, Movers, or history products.

## Code-change workflow

1. Capture a redacted upstream fixture or a deterministic synthetic fixture.
2. Add a parser/unit test for field mapping, units, nulls, timestamps, and identity.
3. Add a dry-run path that performs no database or external-state write.
4. Bound concurrency and retries; avoid unbounded Promise.all.
5. Use explicit typed table operations or a versioned purpose-specific RPC.
6. Keep publication atomic: an exact expected cohort must be complete before serving.
7. Run focused tests, typecheck, lint, and the relevant publication QA.

## Operational boundary

- Do not manually backfill, clean, or write trader_daily_snapshots.
- Do not call exec_sql or an unversioned cleanup/scanner RPC.
- Do not restore or add a schedule until code, provenance, and atomic-finalization
  tests are reviewed.
- Do not deploy a worker, Cloudflare route, Vercel change, or database migration
  without explicit authorization.
- Never log credentials, raw private account data, or secret-bearing URLs.

When evidence is incomplete, report the missing witness and leave the product
dimension unavailable.
