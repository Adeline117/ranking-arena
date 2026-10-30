#!/usr/bin/env node
/**
 * Read-only current-ranking season inventory.
 *
 * Counts current `leaderboard_ranks` rows by source and season. This is an
 * inventory of the serving relation, not proof of freshness or publication
 * eligibility; use check:freshness for the authority verdict.
 *
 * Usage:
 *   node scripts/check_seasons.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')
const SAMPLE_LIMIT = 50_000
const EXPECTED_SEASONS = ['7D', '30D', '90D']

function loadEnvFileIfPresent(path) {
  if (!existsSync(path)) return

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

function requiredConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required'
    )
  }

  return { url, serviceRoleKey }
}

function stringCell(value, fallback = 'unknown') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function latestTimestamp(current, candidate) {
  if (typeof candidate !== 'string' || !Number.isFinite(Date.parse(candidate))) return current
  if (!current || Date.parse(candidate) > Date.parse(current)) return candidate
  return current
}

export function summarizeRankingRows(rows) {
  const counts = new Map()

  for (const row of rows) {
    const source = stringCell(row.source)
    const season = stringCell(row.season_id, 'null')
    const key = `${source}\u0000${season}`
    const summary = counts.get(key) || { source, season, count: 0, latestComputedAt: null }
    summary.count += 1
    summary.latestComputedAt = latestTimestamp(summary.latestComputedAt, row.computed_at)
    counts.set(key, summary)
  }

  return [...counts.values()].sort((left, right) =>
    left.source === right.source
      ? left.season.localeCompare(right.season)
      : left.source.localeCompare(right.source)
  )
}

export async function runSeasonInventory(supabase) {
  console.log('=== Current Ranking Season Inventory ===')
  console.log(`Sampling at most ${SAMPLE_LIMIT.toLocaleString()} ranked rows.\n`)

  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source, season_id, rank, computed_at')
    .not('rank', 'is', null)
    .limit(SAMPLE_LIMIT)

  if (error) throw new Error(`leaderboard_ranks query failed: ${error.message}`)
  const summaries = summarizeRankingRows(data || [])

  if (summaries.length === 0) {
    console.log('No ranked rows returned.')
    console.log('Result: COMPLETE (inventory only; not freshness/publication proof)')
    return
  }

  console.log(
    'Source'.padEnd(20) + 'Season'.padEnd(10) + 'Rows'.padStart(9) + '  Latest computed_at'
  )
  console.log('-'.repeat(72))
  for (const summary of summaries) {
    console.log(
      summary.source.padEnd(20) +
        summary.season.padEnd(10) +
        String(summary.count).padStart(9) +
        `  ${summary.latestComputedAt || 'unknown'}`
    )
  }

  const seasonsBySource = new Map()
  for (const summary of summaries) {
    const seasons = seasonsBySource.get(summary.source) || new Set()
    seasons.add(summary.season)
    seasonsBySource.set(summary.source, seasons)
  }
  const incomplete = [...seasonsBySource.entries()]
    .map(([source, seasons]) => ({
      source,
      missing: EXPECTED_SEASONS.filter((season) => !seasons.has(season)),
    }))
    .filter(({ missing }) => missing.length > 0)

  if (incomplete.length > 0) {
    console.log('\nSources absent from one or more expected seasons in this sample:')
    for (const { source, missing } of incomplete) {
      console.log(`  ${source}: ${missing.join(', ')}`)
    }
  }

  console.log('\nResult: COMPLETE (inventory only; run check:freshness for authority)')
}

async function main() {
  loadEnvFileIfPresent(envPath)
  const { url, serviceRoleKey } = requiredConfig()
  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await runSeasonInventory(supabase)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nResult: ERROR — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
