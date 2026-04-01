module.exports = {
  ci: {
    collect: {
      url: [
        'http://localhost:3000/',
        'http://localhost:3000/rankings/binance_futures',
        'http://localhost:3000/library',
      ],
      numberOfRuns: 1,
      settings: {
        // Use mobile throttling (Lighthouse default)
        preset: 'desktop',
        // Skip some audits that require real network conditions
        skipAudits: ['uses-http2'],
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.5 }],
        'categories:accessibility': ['error', { minScore: 0.8 }],
        'categories:best-practices': ['error', { minScore: 0.8 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
}
