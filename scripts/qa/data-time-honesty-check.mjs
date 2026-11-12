#!/usr/bin/env node
/**
 * Data-time honesty gate (pure file scan, no network).
 *
 * `computed_at` is when Arena recomputed a score; it is not when the exchange
 * data was captured (see lib/rankings/source-freshness.ts). This narrow scan
 * blocks the patterns that turned it into a user-facing "updated" time:
 *
 *   display-key-from-computed-at  a display-time key (lastUpdated, updated_at,
 *                                 asOf, lastmod, dateModified, ...) assigned
 *                                 from computed_at / computedAt
 *   render-computed-at            a .tsx line formatting computed_at as a date
 *                                 (formatTimeAgo / toLocale*String / new Date /
 *                                 formatDataClock / dateTime=)
 *   tracked-since-as-updated      lastUpdated falling back to trackedSince
 *                                 (first-seen time is not a data time)
 *
 * Existing hits are listed in data-time-honesty-allowlist.json with an exact
 * count. A count may only go DOWN: a new hit fails, and a fixed hit fails
 * until its allowlist entry is lowered/removed so the list stays tight.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_ALLOWLIST = path.join(REPO, 'scripts/qa/data-time-honesty-allowlist.json')
const SCAN_DIRS = ['app', 'lib']
const EXCLUDED_PATH_RE =
  /(?:^|\/)(?:__tests__|__mocks__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|^app\/api\/cron\/|^lib\/ingest\/|^lib\/i18n\/|^lib\/supabase\/database\.types\.ts$/

const DISPLAY_KEY =
  '(?:lastUpdated|lastUpdate|latestUpdate|updated_?[aA]t|as_?[oO]f|dataAsOf|dateModified|lastmod|lastModified)'

export const RULES = Object.freeze([
  {
    id: 'display-key-from-computed-at',
    appliesTo: (file) => /\.(?:ts|tsx|mts|js|mjs)$/.test(file),
    // key on the left, computed_at anywhere in the assigned expression.
    pattern: new RegExp(`\\b${DISPLAY_KEY}\\b\\s*[:=](?![=>])[^\\n]*\\bcomputed_?[aA]t\\b`, 'g'),
  },
  {
    id: 'render-computed-at',
    appliesTo: (file) => file.endsWith('.tsx'),
    pattern:
      /(?:formatTimeAgo|toLocale[A-Za-z]*String|new Date|formatDataClock|dateTime=)[^\n]*\bcomputed_?[aA]t\b/g,
  },
  {
    id: 'tracked-since-as-updated',
    appliesTo: (file) => /\.(?:ts|tsx)$/.test(file),
    pattern: /\blastUpdated\s*:[^;]{0,200}?\btrackedSince\b/g,
  },
])

export function scanSource(relativePath, source) {
  const hits = []
  for (const rule of RULES) {
    if (!rule.appliesTo(relativePath)) continue
    rule.pattern.lastIndex = 0
    let match
    while ((match = rule.pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length
      hits.push({ file: relativePath, rule: rule.id, line })
    }
  }
  return hits
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full)
  }
}

export function scanRepository(root = REPO) {
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir)
    if (fs.existsSync(full)) walk(full, files)
  }
  const hits = []
  for (const file of files) {
    const relativePath = path.relative(root, file).replaceAll('\\', '/')
    if (EXCLUDED_PATH_RE.test(relativePath)) continue
    hits.push(...scanSource(relativePath, fs.readFileSync(file, 'utf8')))
  }
  return hits
}

/** Compare hits with the allowlist. Returns a list of failure messages. */
export function compareWithAllowlist(hits, allowlist) {
  const actual = new Map()
  for (const hit of hits) {
    const key = `${hit.file}\u0000${hit.rule}`
    const entry = actual.get(key) ?? { file: hit.file, rule: hit.rule, lines: [] }
    entry.lines.push(hit.line)
    actual.set(key, entry)
  }

  const allowed = new Map()
  for (const entry of allowlist.entries ?? []) {
    allowed.set(`${entry.file}\u0000${entry.rule}`, entry)
  }

  const failures = []
  for (const [key, entry] of actual) {
    const permit = allowed.get(key)
    const count = entry.lines.length
    if (!permit) {
      failures.push(
        `${entry.file}:${entry.lines.join(',')} [${entry.rule}] new data-time violation: use the source watermark (leaderboard_source_freshness.source_as_of) or show unknown; never computed_at/trackedSince.`
      )
    } else if (count > permit.count) {
      failures.push(
        `${entry.file}:${entry.lines.join(',')} [${entry.rule}] ${count} hits exceed the allowlisted ${permit.count}; the allowlist may only shrink.`
      )
    } else if (count < permit.count) {
      failures.push(
        `${entry.file} [${entry.rule}] now has ${count} hits (allowlist ${permit.count}); lower the allowlist count.`
      )
    }
  }
  for (const [key, permit] of allowed) {
    if (!actual.has(key)) {
      failures.push(
        `${permit.file} [${permit.rule}] no longer violates; remove it from the allowlist.`
      )
    }
  }
  return failures
}

export function main(argv = process.argv.slice(2)) {
  const allowlistPath = argv[0] ? path.resolve(argv[0]) : DEFAULT_ALLOWLIST
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
  const hits = scanRepository()
  const failures = compareWithAllowlist(hits, allowlist)
  if (failures.length > 0) {
    console.error('data-time honesty check failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log(
    `data-time honesty check passed (${hits.length} allowlisted hits in ${
      (allowlist.entries ?? []).length
    } entries).`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main()
}
