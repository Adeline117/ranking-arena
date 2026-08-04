# Performance diagnostics

This directory contains the manual single-URL Lighthouse probe. The supported
pull-request performance gate is `.github/workflows/lighthouse-ci.yml`; it owns
the production build, local server lifecycle, audited routes, and retained
artifacts.

## Manual LCP probe

Run the probe against an environment you are authorized to inspect:

```bash
node scripts/performance/measure-lcp.mjs http://localhost:3000
node scripts/performance/measure-lcp.mjs https://your-preview.example
```

The command writes ignored local artifacts:

- `.lighthouse-report.json` — full Lighthouse report
- `.lighthouse-summary.json` — selected metrics and recommendations

It exits non-zero when LCP exceeds 2.5 seconds. Treat the result as diagnostic;
the CI workflow is the release contract.

## Repository-wide audit

`npm run lighthouse` runs the maintained multi-route audit in
`scripts/lighthouse-test.mjs`. Build first when the script requests a local
production bundle, and use only placeholder credentials for pull-request code.

Do not add a second performance workflow or undocumented `perf:*` package
command. Extend the existing workflow and its QA contract instead.
