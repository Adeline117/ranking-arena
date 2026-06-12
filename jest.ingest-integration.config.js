/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Ingest integration test config — `npm run test:ingest-integration`.
 *
 * Deliberately NOT part of the default `npm run test`: these tests open a
 * real Postgres connection (INGEST_DATABASE_URL from worker/.env) and
 * create/drop a dedicated `arena_test` schema. They never read or write
 * production tables — see lib/ingest/serving/__integration__/test-db.ts.
 */
const nextJest = require('next/jest')

const createJestConfig = nextJest({ dir: './' })

module.exports = createJestConfig({
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__integration__/**/*.integration.test.[jt]s'],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.next/',
    '<rootDir>/.claude/worktrees/',
  ],
  // Serial: both suites build/drop the same arena_test schema.
  maxWorkers: 1,
  testTimeout: 120000,
})
