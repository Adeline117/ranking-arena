# Scripts Directory

This directory contains data import, enrichment, verification, and maintenance scripts for Ranking Arena.

## 📁 Directory Structure

```text
scripts/
├── ci/               # Release and workflow gates
├── cron/             # Scheduled runner scripts
├── import/           # Platform data import scripts
├── maintenance/      # Backup, restore, and release maintenance
├── openclaw/         # Automated sentinels and reports
├── performance/      # Performance measurement tools
├── qa/               # Executable QA contracts and sweep tools
├── vps-deploy/       # VPS deployment and runtime helpers
└── *.mjs             # Supported root-level entrypoints and utilities
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
npm run check:freshness
npm run check:platforms
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
- `npm run qa:serving`

### Weekly

- Spot-check enrichment and avatar coverage if needed

### As needed

- Platform-specific import/enrichment scripts
- QA contracts and sweep tools under `scripts/qa/`

---

Retired standalone status and data-validation scripts must not be restored. Use
`npm run diagnose` for routine public diagnostics, `scripts/pipeline-health-check.mjs`
for pipeline investigation, and `npm run qa:serving` for the release acceptance gate.

Pre-arena write scripts and orphaned import/browser helpers must also stay removed. New import and
enrichment tooling must use the current `arena.*` source taxonomy, supported ingest runtime, and
serving contracts.

---

Last updated: 2026-08-03
