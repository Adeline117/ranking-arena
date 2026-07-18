#!/usr/bin/env node
/**
 * Column-level READ-drift guard — the missing half of `qa:insert-drift`.
 *
 * `qa:insert-drift` (insert-column-drift-check) diffs the columns WRITTEN by
 * `.insert/.update/.upsert({...})` against the live schema, catching PGRST204
 * write-500s. Its read-path coverage is only advisory and only scans
 * `app/api` + `lib/data`. The much larger surface — every `.from('t').select(
 * 'a, b, c')` across ALL of `app/` and `lib/` — is a blind spot: if the code
 * selects `display_name` but the table only has `handle`, PostgREST returns
 * **400 / 42703** ("column t.display_name does not exist"), and `safeQuery`
 * (and most `.catch`) swallows it into an empty result. The user sees blank
 * data with NO error. This is a real, recurring class:
 *   - auto-post-market-summary + friends selected columns that were renamed.
 *   - user_profiles.display_name (prod has `handle`, not `display_name`).
 *
 * This scanner extracts selected columns from runtime `.from('t').select(
 * '...')` calls in `app/` + `lib/` (tests/mocks are not application query
 * surfaces), then verifies each column against the LIVE production schema via
 * a PostgREST probe (the exact surface the app queries — views, RLS-exposed
 * cols and all):
 *
 *   GET $URL/rest/v1/<table>?select=<cols>&limit=0
 *     200            → every column exists
 *     400 / 42703    → "column <table>.<col> does not exist"  (READ DRIFT)
 *     404 / PGRST205 → table not REST-exposed (advisory — view / wrong schema)
 *
 * The 42703 message names the exact offending column, so a single batched
 * probe per table peels one bad column at a time (probes are bounded to
 * ~#tables + #drifted-columns, run through a small concurrency pool).
 *
 * Heuristic (regex + PostgREST select grammar), so it has an ALLOWLIST for the
 * unavoidable false positives (dynamic column names, embed sub-columns,
 * mis-attributed `.from`). Bias: **under-report, never over-report** — anything
 * ambiguous (dynamic `${}`, embed `rel(...)`, an `.rpc()` in the chain) is
 * skipped, not flagged.
 *
 * Confirmed column drift → HARD FAIL (exit 1). Table-not-exposed → advisory.
 *
 * Run: node scripts/qa/read-column-drift-check.mjs
 *   (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; env or .env.local)
 */
import fs from 'node:fs'
import path from 'node:path'
import { readEnv } from './qa-auth.mjs'

const REPO = path.resolve(new URL('../..', import.meta.url).pathname)
const SCAN_DIRS = ['app', 'lib']
const PROBE_TIMEOUT_MS = 15_000
const PROBE_CONCURRENCY = 8
const NON_RUNTIME_DIRS = new Set(['__mocks__', '__tests__'])

// (file:table:column) or (table:column) entries that are known-OK. Document why.
// Bias is already toward under-reporting, so this should stay tiny.
const ALLOWLIST = new Set([
  // e.g. 'lib/data/foo.ts:some_table:some_col',  // reason
])

// Tables that are NOT REST-exposed public tables and therefore un-probeable
// from here (PGRST205 is expected, not a bug). Kept out of the advisory noise.
const TABLE_SKIP = new Set([
  // These security-invoker views intentionally grant SELECT only to browser
  // roles. The service-role probe must receive 42501, while production types
  // and the dedicated PG17 migration proof validate their exact columns.
  'group_member_directory',
  'group_member_moderation_directory',
  'own_group_memberships',
])

function walk(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!NON_RUNTIME_DIRS.has(e.name)) walk(p, acc)
    } else if (
      (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
      e.name !== 'database.types.ts' && // generated; not a query surface
      !e.name.endsWith('.d.ts') &&
      !/\.(?:spec|test)\.[cm]?tsx?$/.test(e.name)
    )
      acc.push(p)
  }
  return acc
}

// Extract top-level column names from a PostgREST `.select('...')` string.
// Skips: `*`; embedded resources `rel(...)` / `alias:rel(...)` / `rel!hint(...)`
// (foreign tables, whose columns are NOT columns of THIS table); json/cast ops;
// the `count` aggregate. Resolves `alias:real_col` → `real_col`. Any part that
// carries a `${` interpolation is dropped (dynamic — unknowable).
function selectColumns(sel) {
  if (!sel || sel.includes('*')) return []
  if (sel.includes('${')) {
    // Only drop the interpolated parts, keep clean literal siblings.
    // (handled per-part below via the `${` guard)
  }
  const parts = []
  let depth = 0
  let cur = ''
  for (const c of sel) {
    if (c === '(') {
      depth++
      cur += c
    } else if (c === ')') {
      depth--
      cur += c
    } else if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) parts.push(cur)

  const out = []
  for (let p of parts) {
    p = p.trim()
    if (!p) continue
    if (p.includes('(')) continue // embedded resource rel(...) — not a column here
    if (p.includes('${')) continue // dynamic fragment — unknowable, skip
    if (p.includes(':')) p = p.split(':').pop().trim() // alias:real_col → real_col
    if (p.includes('!')) p = p.split('!')[0].trim() // rel!hint (shouldn't reach — no paren)
    p = p.split('->')[0].split('::')[0].trim() // strip json ops / casts
    if (p === 'count') continue // PostgREST count() aggregate, valid on any query
    if (/^[a-z_][a-z0-9_]*$/i.test(p)) out.push(p)
  }
  return out
}

function lineOf(src, idx) {
  let line = 1
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++
  return line
}

// table -> Map(column -> Set("rel:line"))
function collectUsages(files) {
  const usages = new Map()
  const add = (table, col, ref) => {
    if (!usages.has(table)) usages.set(table, new Map())
    const m = usages.get(table)
    if (!m.has(col)) m.set(col, new Set())
    m.get(col).add(ref)
  }

  // .select('...') / .select("...") / .select(`...`)  — first string arg only
  const reSelect = /\.select\(\s*(['"`])([\s\S]*?)\1/g

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = f.replace(REPO + '/', '')
    let s
    while ((s = reSelect.exec(src))) {
      const selStr = s[2]
      // nearest preceding .from('table') in the same chain (within 700 chars)
      const winStart = Math.max(0, s.index - 700)
      const before = src.slice(winStart, s.index)
      const froms = [...before.matchAll(/\.from\(\s*['"`](\w+)['"`]\s*\)/g)]
      if (!froms.length) continue // dynamic/undetectable table — skip (under-report)
      const lastFrom = froms[froms.length - 1]
      const table = lastFrom[1]
      // Guard: if an `.rpc(` sits between the chosen .from and the .select, the
      // select likely belongs to the rpc result set, not this table → skip.
      const fromEndInWin = lastFrom.index + lastFrom[0].length
      const between = before.slice(fromEndInWin)
      if (/\.rpc\(/.test(between)) continue

      const line = lineOf(src, s.index)
      for (const col of selectColumns(selStr)) add(table, col, `${rel}:${line}`)
    }
  }
  return usages
}

async function probe(base, key, table, cols) {
  // Returns { status, code, message } for GET ?select=<cols>&limit=0
  const url = `${base}/rest/v1/${encodeURIComponent(table)}?select=${cols
    .map(encodeURIComponent)
    .join(',')}&limit=0`
  const res = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (res.ok) return { status: res.status, code: null, message: null }
  const body = await res.json().catch(() => null)
  return { status: res.status, code: body?.code ?? null, message: body?.message ?? '' }
}

// Peel columns for one table: batch-probe, and on 42703 remove the named column
// and re-probe until 200 (all clean) or the list empties.
async function driftForTable(base, key, table, cols) {
  const remaining = [...cols]
  const drifted = []
  let guard = remaining.length + 2
  while (remaining.length && guard-- > 0) {
    const r = await probe(base, key, table, remaining)
    if (r.status === 200) break
    if (r.status === 404 || r.code === 'PGRST205') return { tableMissing: true, drifted: [] }
    if (r.code === '42703') {
      // message: "column <table>.<col> does not exist"
      const m = r.message.match(/column\s+(?:[\w.]+\.)?"?([a-zA-Z_][\w]*)"?\s+does not exist/i)
      if (!m) return { tableMissing: false, drifted, unresolved: r.message }
      const bad = m[1]
      drifted.push(bad)
      const before = remaining.length
      const idx = remaining.indexOf(bad)
      if (idx >= 0) remaining.splice(idx, 1)
      if (remaining.length === before)
        return { tableMissing: false, drifted, unresolved: r.message }
    } else {
      // Unexpected (auth, 500, PGRST embed error, etc.) — do not fabricate drift.
      return {
        tableMissing: false,
        drifted,
        unresolved: `${r.status} ${r.code || ''} ${r.message}`,
      }
    }
  }
  return { tableMissing: false, drifted }
}

async function pool(items, n, fn) {
  const results = []
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const base = readEnv('NEXT_PUBLIC_SUPABASE_URL', { optional: true })
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY', { optional: true })
  if (!base || !key) {
    // CI-safe: without prod REST access the guard cannot run. Skip (exit 0)
    // rather than fail so wiring this into CI never breaks the build before the
    // secrets are configured. Set both to enable the hard gate.
    console.log(
      '⏭️  read-column-drift-check SKIPPED — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'
    )
    process.exit(0)
  }

  const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO, d)))
  const usages = collectUsages(files)

  const tables = [...usages.keys()].filter((t) => !TABLE_SKIP.has(t))
  const perTable = await pool(tables, PROBE_CONCURRENCY, async (table) => {
    const cols = [...usages.get(table).keys()].filter(
      (c) =>
        !ALLOWLIST.has(`${table}:${c}`) &&
        ![...usages.get(table).get(c)].every((ref) =>
          ALLOWLIST.has(`${ref.split(':')[0]}:${table}:${c}`)
        )
    )
    if (!cols.length) return { table, drifted: [], tableMissing: false }
    const res = await driftForTable(base, key, table, cols)
    return { table, ...res }
  })

  const drift = [] // { table, col, refs[] }
  const missingTables = []
  const unresolved = []
  for (const r of perTable) {
    if (r.tableMissing) {
      missingTables.push(r.table)
      continue
    }
    if (r.unresolved) unresolved.push({ table: r.table, msg: r.unresolved })
    for (const col of r.drifted || []) {
      const refs = [...usages.get(r.table).get(col)].filter(
        (ref) => !ALLOWLIST.has(`${ref.split(':')[0]}:${r.table}:${col}`)
      )
      if (refs.length) drift.push({ table: r.table, col, refs })
    }
  }

  if (missingTables.length) {
    console.warn(
      `\n⚠️  ${missingTables.length} table(s) referenced by .from() are not REST-exposed public tables (advisory — likely a view/other schema; verify separately):`
    )
    for (const t of missingTables.sort()) console.warn(`   ${t}`)
  }
  if (unresolved.length) {
    console.warn(
      `\n⚠️  ${unresolved.length} probe(s) returned an unexpected status (not counted as drift):`
    )
    for (const u of unresolved) console.warn(`   ${u.table} → ${u.msg}`)
  }

  if (!drift.length) {
    console.log(
      `\n✅ read-drift 0 — every .select() column across ${files.length} files exists in production` +
        `${missingTables.length ? ` (${missingTables.length} table(s) advisory)` : ''}`
    )
    process.exit(0)
  }

  console.error(
    `\n❌ ${drift.length} read-drift column(s) — .select() reads a column missing from production:\n`
  )
  drift.sort((a, b) => a.table.localeCompare(b.table) || a.col.localeCompare(b.col))
  for (const d of drift) {
    console.error(`  ${d.table}.${d.col}  — missing in prod`)
    for (const ref of [...d.refs].sort()) console.error(`      ${ref}`)
  }
  console.error(
    `\nEach 400s (PGRST 42703) at runtime and is usually swallowed by safeQuery into empty data.` +
      ` Fix = correct the column name to the real production column (REST-verify first),` +
      ` or add the column via migration. False positives → ALLOWLIST (document why).`
  )
  process.exit(1)
}

main().catch((e) => {
  console.error('[read-column-drift-check] crashed:', e.message)
  process.exit(2)
})
