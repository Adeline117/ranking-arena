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
      // Current (2026-07-03 冲30% Wave 2): statements 26.28%, branches 24.57%, lines 26.48%, functions 21.39%
      // (+posts-weighted/data-source-priority/hot-score/personal/hashtags/trader-utils;
      //  Wave 2 修复两个真 bug:posts-weighted 幻影 .join() 必 500、hashtags CJK 标签静默丢失)
      branches: 24.5,
      functions: 21.3,
      lines: 26.4,
      statements: 26.2,
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
