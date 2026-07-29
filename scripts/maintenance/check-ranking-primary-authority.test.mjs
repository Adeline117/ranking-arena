import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  RANKING_PRIMARY_PROJECT_REF,
  RANKING_PRIMARY_SUPABASE_ORIGIN,
  checkRankingPrimaryAuthorityEnvironment,
  validateRankingDatabaseUrl,
  validateRankingSupabaseUrl,
} from './check-ranking-primary-authority.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/maintenance/check-ranking-primary-authority.mjs')
const DIRECT_URL =
  `postgresql://postgres:direct-secret@db.${RANKING_PRIMARY_PROJECT_REF}.supabase.co:` +
  '5432/postgres?sslmode=verify-full'
const POOLER_URL =
  `postgresql://postgres.${RANKING_PRIMARY_PROJECT_REF}:pooler-secret@` +
  'aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require'

test('accepts production API, direct, and transaction-pooler identities', () => {
  assert.equal(
    validateRankingSupabaseUrl(RANKING_PRIMARY_SUPABASE_ORIGIN, 'NEXT_PUBLIC_SUPABASE_URL'),
    RANKING_PRIMARY_PROJECT_REF
  )
  assert.deepEqual(validateRankingDatabaseUrl(DIRECT_URL, 'DATABASE_URL'), {
    endpoint: 'direct',
    projectRef: RANKING_PRIMARY_PROJECT_REF,
  })
  assert.deepEqual(validateRankingDatabaseUrl(POOLER_URL, 'DATABASE_POOLER_URL'), {
    endpoint: 'pooler',
    projectRef: RANKING_PRIMARY_PROJECT_REF,
  })
})

test('checks the runtime-selected URL and every separately configured database authority', () => {
  assert.deepEqual(
    checkRankingPrimaryAuthorityEnvironment({
      env: {
        NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN,
        SUPABASE_URL: `${RANKING_PRIMARY_SUPABASE_ORIGIN}/`,
        DATABASE_POOLER_URL: POOLER_URL,
        DATABASE_URL: DIRECT_URL,
      },
    }),
    {
      checkedDatabaseVariables: ['DATABASE_POOLER_URL', 'DATABASE_URL'],
      databaseEndpoints: {
        DATABASE_POOLER_URL: 'pooler',
        DATABASE_URL: 'direct',
      },
      effectiveDatabaseVariable: 'DATABASE_POOLER_URL',
      projectRef: RANKING_PRIMARY_PROJECT_REF,
    }
  )

  const fallback = checkRankingPrimaryAuthorityEnvironment({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN,
      DATABASE_URL: DIRECT_URL,
    },
  })
  assert.equal(fallback.effectiveDatabaseVariable, 'DATABASE_URL')
})

test('fails closed on missing, foreign, disguised, or structurally unsafe API identities', () => {
  for (const invalid of [
    undefined,
    '',
    `http://${RANKING_PRIMARY_PROJECT_REF}.supabase.co`,
    'https://otherprojectref000000.supabase.co',
    `${RANKING_PRIMARY_SUPABASE_ORIGIN}.evil.example`,
    `${RANKING_PRIMARY_SUPABASE_ORIGIN}/rest/v1`,
    `${RANKING_PRIMARY_SUPABASE_ORIGIN}?project=other`,
    `${RANKING_PRIMARY_SUPABASE_ORIGIN}#other`,
    RANKING_PRIMARY_SUPABASE_ORIGIN.replace('https://', 'https://user:secret@'),
  ]) {
    assert.throws(
      () => validateRankingSupabaseUrl(invalid, 'NEXT_PUBLIC_SUPABASE_URL'),
      /NEXT_PUBLIC_SUPABASE_URL/
    )
  }
})

test('fails closed on foreign database projects and connection-string overrides', () => {
  const foreignRef = 'aaaaaaaaaaaaaaaaaaaa'
  const invalid = [
    undefined,
    '',
    DIRECT_URL.replace(RANKING_PRIMARY_PROJECT_REF, foreignRef),
    DIRECT_URL.replace('db.', 'db.evil.'),
    DIRECT_URL.replace('postgres:direct-secret', 'postgres.other:direct-secret'),
    DIRECT_URL.replace(':5432/', ':6543/'),
    DIRECT_URL.replace('/postgres?', '/other?'),
    DIRECT_URL.replace('postgresql:', 'https:'),
    DIRECT_URL.replace('direct-secret', ''),
    `${DIRECT_URL}&host=db.${foreignRef}.supabase.co`,
    `${DIRECT_URL}&user=postgres.other`,
    `${DIRECT_URL}#foreign`,
    POOLER_URL.replace(`postgres.${RANKING_PRIMARY_PROJECT_REF}`, `postgres.${foreignRef}`),
    POOLER_URL.replace('pooler.supabase.com', 'pooler.supabase.com.evil.example'),
    POOLER_URL.replace(':6543/', ':6432/'),
    POOLER_URL.replace('sslmode=require', 'sslmode=disable'),
    `${POOLER_URL}&sslmode=verify-full`,
  ]

  for (const databaseUrl of invalid) {
    assert.throws(
      () => validateRankingDatabaseUrl(databaseUrl, 'DATABASE_POOLER_URL'),
      /DATABASE_POOLER_URL/
    )
  }
})

test('does not fall back around a bad pooler or ignore a mismatched migration URL', () => {
  const foreignDirect = DIRECT_URL.replace(RANKING_PRIMARY_PROJECT_REF, 'aaaaaaaaaaaaaaaaaaaa')
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN,
    DATABASE_POOLER_URL: POOLER_URL,
    DATABASE_URL: DIRECT_URL,
  }

  assert.throws(
    () =>
      checkRankingPrimaryAuthorityEnvironment({
        env: { ...base, DATABASE_POOLER_URL: foreignDirect },
      }),
    /DATABASE_POOLER_URL/
  )
  assert.throws(
    () =>
      checkRankingPrimaryAuthorityEnvironment({
        env: { ...base, DATABASE_URL: foreignDirect },
      }),
    /DATABASE_URL/
  )
  assert.throws(
    () =>
      checkRankingPrimaryAuthorityEnvironment({
        env: { NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN },
      }),
    /DATABASE_POOLER_URL or DATABASE_URL is required/
  )
})

test('CLI reports only variable names and never connection credentials', () => {
  const accepted = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN,
      DATABASE_POOLER_URL: POOLER_URL,
      DATABASE_URL: DIRECT_URL,
    },
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(accepted.stdout, /environment gate passed/)
  assert.match(accepted.stdout, /runtime DATABASE_POOLER_URL/)
  assert.doesNotMatch(accepted.stdout, /direct-secret|pooler-secret|postgresql:/)

  const rejected = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NEXT_PUBLIC_SUPABASE_URL: RANKING_PRIMARY_SUPABASE_ORIGIN,
      DATABASE_POOLER_URL: POOLER_URL.replace(RANKING_PRIMARY_PROJECT_REF, 'aaaaaaaaaaaaaaaaaaaa'),
    },
  })
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /DATABASE_POOLER_URL/)
  assert.doesNotMatch(rejected.stderr, /pooler-secret|postgresql:|supabase\.com/)
})
