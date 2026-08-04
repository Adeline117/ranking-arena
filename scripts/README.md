# Repository Scripts

This directory contains repository automation, diagnostics, release checks, and
one-off maintenance tools. Application and ingestion runtime code belongs under
`app/`, `lib/`, and `worker/`; scripts are not production entrypoints unless they
are explicitly listed in `PRODUCTION_ALLOWLIST.json`.

## Canonical diagnostics

The routine diagnostic checks the same public serving contracts used by the
application. It does not require database credentials.

```bash
npm run diagnose
npm run check:status
npm run check:freshness
npm run check:platforms
```

`npm run diagnose` runs all three sections. Set `ARENA_URL` to test a local or
preview deployment; it defaults to the production site.

For an internal, read-only active-source freshness check, run:

```bash
node scripts/pipeline-health-check.mjs
node scripts/pipeline-health-check.mjs --quick
```

That command requires the Supabase URL and service-role key. `--fix` only prints
remediation suggestions; it does not execute them.

## Production boundary

Run `npm run check:scripts-boundary` before changing production operations. The
gate fails closed when an allowlisted entry is malformed, duplicated, nested,
missing, has an unsupported extension, or is a symbolic link. Root scripts not
on the allowlist are reported only and are never executed by the gate.

## Directory map

| Path                                            | Purpose                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `qa/`, `ci/`                                    | Architecture, contract, release, and deployment gates      |
| `__tests__/`, `test-helpers/`, `fixtures/`      | Script tests and deterministic fixtures                    |
| `maintenance/`                                  | Reviewed backup, restore, migration, and cache operations  |
| `openclaw/`                                     | Alert-only sentinels and operational reports               |
| `cron/`                                         | Retirement-only tombstones and uninstall/status helpers    |
| `vps/`, `vps-deploy/`                           | Active regional worker/proxy checks and deployment tooling |
| `git-hooks/`                                    | Version-controlled commit-message policy                   |
| `lib/`                                          | Shared modules for current script families                 |
| `flash-news/`, `social-seed/`                   | Domain-specific content utilities                          |
| `clickhouse/`, `migration-reconcile/`           | Explicit schema and migration support                      |
| `performance/`, `security/`, `email-templates/` | Specialized repository tooling and assets                  |
| `archive/`                                      | Historical references; not supported production commands   |

The canonical data-ingestion implementation is the regional ingest worker and
`lib/ingest`; retired ad-hoc `scripts/import` and local library collectors must
not be recreated as parallel runtimes.
