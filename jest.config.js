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
  ],
  collectCoverageFrom: [
    'lib/**/*.{ts,tsx}',
    'app/components/**/*.{ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/*.test.{ts,tsx}',
    '!**/index.ts',
  ],
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
  testTimeout: 10000,
  coverageThreshold: {
    global: {
      branches: 30,
      functions: 30,
      lines: 40,
      statements: 40,
    },
  },
}

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
// We wrap to add ESM-only packages to transformIgnorePatterns (next/jest overwrites the user-provided value)
const baseConfig = createJestConfig(customJestConfig)
module.exports = async () => {
  const config = await baseConfig()
  // Add ESM-only packages that Jest must transform
  const esmPackages = ['uncrypto']
  config.transformIgnorePatterns = config.transformIgnorePatterns?.map(pattern => {
    // Inject ESM packages into the negative lookahead of node_modules patterns
    if (pattern.includes('node_modules') && pattern.includes('(?!')) {
      return pattern.replace('(?!', `(?!(${esmPackages.join('|')})|`)
    }
    return pattern
  }) || []
  return config
}


