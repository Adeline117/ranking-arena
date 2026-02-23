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

This runs:
- seasons check
- status check
- freshness check
- platform freshness check
- tables check
- enrichment check

Run one check only:

```bash
node scripts/diagnose.mjs --seasons
node scripts/diagnose.mjs --status
node scripts/diagnose.mjs --freshness
node scripts/diagnose.mjs --platforms
node scripts/diagnose.mjs --tables
node scripts/diagnose.mjs --enrichment
```

Backward-compatible shortcuts still work:

```bash
npm run check:seasons
npm run check:status
npm run check:tables
npm run check:enrichment
```

## 📝 Environment Requirements

Most scripts require:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Some enrichment/fetch scripts may also require proxy credentials.

## 🔧 Operations Rhythm

### Daily/Before release
- `npm run diagnose`

### Weekly
- Spot-check enrichment and avatar coverage if needed

### As needed
- Platform-specific import/enrichment scripts
- Verification scripts under `scripts/verify/`

---

Last updated: 2026-02-22
