const defaultOrigin = 'http://127.0.0.1:3000'
const configuredOrigin = process.env.LHCI_ORIGIN || defaultOrigin
let origin

try {
  const parsedOrigin = new URL(configuredOrigin)
  const port = Number(parsedOrigin.port)
  const isLoopbackOrigin =
    parsedOrigin.protocol === 'http:' &&
    parsedOrigin.hostname === '127.0.0.1' &&
    parsedOrigin.username === '' &&
    parsedOrigin.password === '' &&
    parsedOrigin.pathname === '/' &&
    parsedOrigin.search === '' &&
    parsedOrigin.hash === '' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535

  if (!isLoopbackOrigin) throw new Error('origin is not a loopback HTTP origin')
  origin = parsedOrigin.origin
} catch (error) {
  throw new Error(`Invalid LHCI_ORIGIN: ${error.message}`)
}

module.exports = {
  ci: {
    collect: {
      url: [`${origin}/`, `${origin}/methodology`, `${origin}/about`],
      numberOfRuns: 3,
      settings: {
        // Desktop is intentional: mobile coverage remains in Playwright/nightly.
        preset: 'desktop',
        // Skip some audits that require real network conditions
        skipAudits: ['uses-http2'],
      },
    },
    assert: {
      assertions: {
        'http-status-code': 'error',
        'categories:performance': ['error', { minScore: 0.5 }],
        'categories:accessibility': ['error', { minScore: 0.8 }],
        'categories:best-practices': ['error', { minScore: 0.8 }],
      },
    },
    upload: {
      // Future `autorun` calls must remain local; PR reports are not public data.
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
}
