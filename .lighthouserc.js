/**
 * Lighthouse CI Configuration
 *
 * Run locally:
 *   npx @lhci/cli autorun
 *
 * Or in CI:
 *   npm run build && npm start &
 *   npx @lhci/cli autorun
 *
 * @see https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
 */
module.exports = {
  ci: {
    collect: {
      // Use the built Next.js server
      startServerCommand: 'npm start',
      startServerReadyPattern: 'Ready in',
      startServerReadyTimeout: 30000,
      url: [
        'http://localhost:3000/',
        'http://localhost:3000/groups',
      ],
      // Run 3 times per URL for stability
      numberOfRuns: 3,
      settings: {
        // Use mobile preset (Lighthouse default)
        preset: 'desktop',
        // Skip some audits that require real network
        skipAudits: ['uses-http2'],
        // Chrome flags for CI
        chromeFlags: '--no-sandbox --disable-gpu --headless',
      },
    },
    assert: {
      assertions: {
        // Core Web Vitals thresholds
        'categories:performance': ['warn', { minScore: 0.70 }],
        'categories:accessibility': ['error', { minScore: 0.90 }],
        'categories:seo': ['error', { minScore: 0.90 }],
        'categories:best-practices': ['warn', { minScore: 0.80 }],

        // Specific CWV metrics
        'first-contentful-paint': ['warn', { maxNumericValue: 3000 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 4000 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['warn', { maxNumericValue: 600 }],
      },
    },
    upload: {
      // Output HTML report locally
      target: 'filesystem',
      outputDir: './lighthouse-ci-report',
      reportFilenamePattern: '%%HOSTNAME%%-%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%',
    },
  },
}
