# Scripts Directory

This directory contains data import, enrichment, verification, and maintenance scripts for Ranking Arena.

## 📁 Directory Structure

```text
scripts/
├── import/           # Platform data import scripts
├── maintenance/      # Data cleanup and calculations
├── monitoring/       # Data quality and freshness monitoring
├── verify/           # Verification and consistency checks
├── test/             # Script test utilities
├── performance/      # Performance measurement tools
├── setup/            # Environment/setup helpers
├── shell/            # Shell-based ops helpers
├── sql/              # SQL snippets and helpers
├── cron/             # Scheduled runner scripts
└── *.mjs             # Root-level entrypoints and utilities
```

## ✅ Unified Diagnostics Entry

Use the single diagnostics entrypoint for routine checks:

```bash
npm run diagnose
```

The default run includes the credentialed season and enrichment inventories. Without
controlled Supabase read credentials it exits nonzero rather than claiming success;
use the individual public checks when only public observation is available.

This runs:

- current-ranking season inventory
- public serving status check
- public freshness check
- public platform coverage check
- non-authoritative enrichment inventory

Run one check only:

```bash
node scripts/diagnose.mjs --seasons
node scripts/diagnose.mjs --status
node scripts/diagnose.mjs --freshness
node scripts/diagnose.mjs --platforms
node scripts/diagnose.mjs --enrichment
```

Backward-compatible shortcuts still work:

```bash
npm run check:seasons
npm run check:status
npm run check:freshness
npm run check:platforms
npm run check:enrichment
```

## 📝 Environment Requirements

The season and enrichment inventories require:

- `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

They are read-only diagnostics: a successful inventory query does not prove source
freshness, published cohort membership, or authority to serve an enrichment metric.
Use `npm run check:freshness` for the public ranking authority verdict. Never add a
proxy credential, backfill, cron invocation, or cleanup step to make a diagnostic
pass.

## 🔧 Operations Rhythm

### Daily/Before release

- `npm run diagnose`

### Weekly

- Spot-check enrichment and avatar coverage if needed

### As needed

- Platform-specific import/enrichment scripts
- Verification scripts under `scripts/verify/`

---

Last updated: 2026-08-16
