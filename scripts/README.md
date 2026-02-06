# Scripts Directory

This directory contains data import, enrichment, and maintenance scripts for Ranking Arena.

## 📁 Directory Structure

```
scripts/
├── import/           # Platform data import scripts
├── maintenance/      # Data cleanup and calculation scripts
├── monitoring/       # Data quality monitoring
├── performance/      # Performance measurement tools
├── setup/            # Initial setup scripts
├── test/             # Script testing utilities
├── verify/           # Data verification scripts
└── *.mjs             # Root-level utility scripts
```

## 🔄 Script Consolidation Plan

### Avatar Fetching Scripts (Can be consolidated)
- `fetch-platform-avatars.mjs` - Generic avatar fetcher
- `enrich-htx-avatars.mjs` - HTX-specific
- `enrich-lbank-avatars.mjs` - LBank-specific
- `enrich-xt-avatars.mjs` - XT-specific
- `fetch-missing-avatars.mjs` - Missing avatar补充
- `fill-avatars.mjs` - Avatar filling

**Consolidation target**: Create `scripts/unified-avatar-fetch.mjs` with `--platform` flag

### Enrichment Scripts (Can be consolidated)
- `enrich-all-platforms.mjs` - All platforms
- `enrich-via-proxy.mjs` - Via proxy
- `enrich-via-cf-proxy.mjs` - Via Cloudflare proxy
- `enrich-bitget.mjs` - Bitget-specific
- `playwright-enrich.mjs` - Playwright-based
- `playwright-enrich-all.mjs` - Playwright all platforms

**Consolidation target**: Create `scripts/unified-enrich.mjs` with `--platform`, `--proxy`, `--method` flags

## 📝 Usage Recommendations

### Active Scripts (Keep as-is)
- `check_enrichment.mjs` - Monitor enrichment status
- `check-avatar-coverage.mjs` - Monitor avatar coverage
- `enrich-snapshots.mjs` - Snapshot enrichment

### Deprecated Scripts (Can be removed after consolidation)
- Individual platform-specific enrichment scripts
- Duplicate avatar fetching scripts

## 🚀 Quick Start

```bash
# Check data quality
npm run scripts:check-enrichment

# Enrich all platforms (proposed)
node scripts/unified-enrich.mjs --all

# Fetch avatars for specific platform (proposed)
node scripts/unified-avatar-fetch.mjs --platform binance
```

## 📊 Script Categories

### 1. Data Import
Located in `scripts/import/`
- Platform-specific scrapers
- API-based importers
- Browser-based scrapers

### 2. Data Enrichment
Root level + proxy variants
- Avatar enrichment
- Profile data enrichment
- Historical data補充

### 3. Maintenance
Located in `scripts/maintenance/`
- Daily aggregation
- Score calculation
- Data cleanup

### 4. Monitoring
Located in `scripts/monitoring/`
- Data freshness checks
- Field mapping analysis
- Coverage monitoring

## ⚠️ Important Notes

1. Most scripts require environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

2. Proxy scripts require additional config:
   - `PROXY_URL` or Cloudflare credentials

3. Always test scripts on a small dataset first

## 🔧 Maintenance Tasks

### Weekly
- Run `check-avatar-coverage.mjs`
- Run `check_enrichment.mjs`

### Monthly
- Review and consolidate new scripts
- Update this README

### As Needed
- Platform-specific enrichment when data is stale
- Avatar fetching for new traders

## 📌 Future Improvements

- [ ] Consolidate avatar scripts into unified tool
- [ ] Consolidate enrichment scripts into unified tool
- [ ] Add --dry-run flag to all scripts
- [ ] Add progress bars for long-running scripts
- [ ] Implement retry logic for failed fetches
- [ ] Add comprehensive logging

---

Last updated: 2026-02-06
