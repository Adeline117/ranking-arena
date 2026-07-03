/* eslint-disable @typescript-eslint/no-require-imports */
const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: './',
})

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.next/',
    '<rootDir>/e2e/',
    '<rootDir>/.claude/worktrees/',
    // Real-DB integration tests run via `npm run test:ingest-integration` only.
    '\\.integration\\.test\\.',
  ],
  collectCoverageFrom: [
    'lib/**/*.{ts,tsx}',
    'app/components/**/*.{ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/*.test.{ts,tsx}',
    '!**/index.ts',
  ],
  testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  testTimeout: 10000,
  coverageThreshold: {
    global: {
      // Ratchet: set just below current levels so coverage can only go UP.
      // Raise these after each coverage improvement. Never lower them.
      // Current (2026-07-03 batch 10+): statements 22.45%, branches 20.64%, lines 22.63%, functions 17.58%
      // (climbing via lib/utils + pipeline/calculator + wallet/badges test batches)
      branches: 20.5,
      functions: 17.5,
      lines: 22.5,
      statements: 22.4,
    },
  },
}

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
// We wrap to add ESM-only packages to transformIgnorePatterns (next/jest overwrites the user-provided value)
const baseConfig = createJestConfig(customJestConfig)
module.exports = async () => {
  const config = await baseConfig()
  // Add ESM-only packages that Jest must transform
  const esmPackages = ['uncrypto', '@exodus/bytes']
  config.transformIgnorePatterns =
    config.transformIgnorePatterns?.map((pattern) => {
      // Inject ESM packages into the negative lookahead of node_modules patterns
      if (pattern.includes('node_modules') && pattern.includes('(?!')) {
        return pattern.replace('(?!', `(?!(${esmPackages.join('|')})|`)
      }
      return pattern
    }) || []
  return config
}
