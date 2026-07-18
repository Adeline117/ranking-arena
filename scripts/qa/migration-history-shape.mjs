#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
const DEFAULT_BASELINE_PATH = path.join(
  ROOT,
  'scripts',
  'qa',
  'migration-history-shape-baseline.txt'
)

export const MODERN_MIGRATION_PATTERN = /^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/
export const LEGACY_LETTER_VERSION_PATTERN = /^\d+[a-z][a-z0-9]*_/
export const KNOWN_SHORT_COLLISION_PATHS = Object.freeze([
  'supabase/migrations/20260307_add_trader_type.sql',
  'supabase/migrations/20260310_fix_snapshots_v2_unique_constraint.sql',
  'supabase/migrations/20260313_add_is_bot_to_profiles_v2.sql',
])
export const EXPECTED_LEGACY_BASELINE_COUNT = 191
export const EXPECTED_LEGACY_LETTER_VERSION_COUNT = 93

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

export function parseLegacyBaseline(text) {
  const entries = new Map()

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^([a-f0-9]{64})\s{2}(.+\.sql)$/u)
    if (!match) {
      throw new Error(`invalid migration history baseline line ${index + 1}`)
    }

    const [, digest, migrationPath] = match
    if (!migrationPath.startsWith('supabase/migrations/')) {
      throw new Error(`baseline path must stay under supabase/migrations: ${migrationPath}`)
    }
    if (MODERN_MIGRATION_PATTERN.test(path.posix.basename(migrationPath))) {
      throw new Error(`14-digit migration must not be legacy-allowlisted: ${migrationPath}`)
    }
    if (entries.has(migrationPath)) {
      throw new Error(`duplicate migration history baseline path: ${migrationPath}`)
    }
    entries.set(migrationPath, digest)
  }

  return entries
}

export function validateCommittedBaseline(baseline) {
  const errors = []
  const paths = [...baseline.keys()]
  const letterVersionPaths = paths.filter((migrationPath) =>
    LEGACY_LETTER_VERSION_PATTERN.test(path.posix.basename(migrationPath))
  )

  if (baseline.size !== EXPECTED_LEGACY_BASELINE_COUNT) {
    errors.push(
      `legacy migration baseline must contain exactly ${EXPECTED_LEGACY_BASELINE_COUNT} paths; found ${baseline.size}`
    )
  }

  if (letterVersionPaths.length !== EXPECTED_LEGACY_LETTER_VERSION_COUNT) {
    errors.push(
      `legacy letter-version baseline must contain exactly ${EXPECTED_LEGACY_LETTER_VERSION_COUNT} paths; found ${letterVersionPaths.length}`
    )
  }

  for (const migrationPath of KNOWN_SHORT_COLLISION_PATHS) {
    if (!baseline.has(migrationPath)) {
      errors.push(`short-version collision is missing from baseline: ${migrationPath}`)
    }
  }

  return errors
}

export function analyzeMigrationEntries(entries, baseline) {
  const errors = []
  const versions = new Map()
  let modernCount = 0
  let legacyCount = 0
  let legacyLetterVersionCount = 0
  let shortCollisionCount = 0

  for (const entry of entries) {
    const migrationPath = entry.path.replaceAll(path.sep, '/')
    const fileName = path.posix.basename(migrationPath)
    if (!fileName.endsWith('.sql')) continue

    const modern = fileName.match(MODERN_MIGRATION_PATTERN)
    if (modern) {
      modernCount += 1
      const version = modern[1]
      const versionPaths = versions.get(version) ?? []
      versionPaths.push(migrationPath)
      versions.set(version, versionPaths)
      continue
    }

    legacyCount += 1
    if (LEGACY_LETTER_VERSION_PATTERN.test(fileName)) {
      legacyLetterVersionCount += 1
    }
    if (KNOWN_SHORT_COLLISION_PATHS.includes(migrationPath)) {
      shortCollisionCount += 1
    }

    const expectedDigest = baseline.get(migrationPath)
    if (!expectedDigest) {
      errors.push(
        `new migration must use a 14-digit numeric version and safe slug: ${migrationPath}`
      )
      continue
    }

    const actualDigest = sha256(entry.contents)
    if (actualDigest !== expectedDigest) {
      errors.push(
        `legacy migration fingerprint changed: ${migrationPath} (expected ${expectedDigest}, got ${actualDigest})`
      )
    }
  }

  for (const [version, versionPaths] of versions) {
    if (versionPaths.length > 1) {
      errors.push(`duplicate 14-digit migration version ${version}: ${versionPaths.join(', ')}`)
    }
  }

  return {
    errors,
    summary: {
      migrationCount: modernCount + legacyCount,
      modernCount,
      legacyCount,
      legacyLetterVersionCount,
      shortCollisionCount,
    },
  }
}

export function scanMigrationDirectory({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  baselinePath = DEFAULT_BASELINE_PATH,
} = {}) {
  const baseline = parseLegacyBaseline(readFileSync(baselinePath, 'utf8'))
  const baselineErrors = validateCommittedBaseline(baseline)
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      path: `supabase/migrations/${entry.name}`,
      contents: readFileSync(path.join(migrationsDir, entry.name)),
    }))
  const result = analyzeMigrationEntries(entries, baseline)

  return {
    errors: [...baselineErrors, ...result.errors],
    summary: {
      ...result.summary,
      baselineCount: baseline.size,
    },
  }
}

export function main() {
  const result = scanMigrationDirectory()
  if (result.errors.length > 0) {
    console.error('Migration history shape check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  const {
    migrationCount,
    modernCount,
    legacyCount,
    legacyLetterVersionCount,
    shortCollisionCount,
  } = result.summary
  console.log(
    `Migration history shape is stable: ${migrationCount} files; ` +
      `${modernCount} modern, ${legacyCount} fingerprinted legacy ` +
      `(${legacyLetterVersionCount} letter-version, ${shortCollisionCount} short-collision).`
  )
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
}
