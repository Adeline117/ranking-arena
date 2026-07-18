#!/usr/bin/env node
/**
 * Column-level write-drift guard — the missing half of `qa:schema`.
 *
 * `qa:schema` (schema-contract-check) verifies TABLES and RPCs the code depends
 * on exist in production. It does NOT verify that the COLUMNS written by
 * `.insert()/.update()/.upsert()` exist — so code can write a column that was
 * never migrated and every call 500s silently. This is a real, recurring bug:
 *   - 2026-07-02 groups.slug: /api/groups/apply inserted `slug`, prod `groups`
 *     had no such column → EVERY group creation 500'd (PGRST204). Undetected.
 *   - Same audit found the same class in Stripe webhooks, quiz save, exchange
 *     OAuth PKCE, tip/gifts, group comment soft-delete, …
 *
 * This scanner extracts object keys from runtime `.from('t').insert/update/
 * upsert({...})` calls in app/api + lib/data (tests/mocks are not application
 * query surfaces), and diffs them against the LIVE production column list
 * (information_schema via DATABASE_URL). Any key not a real column = a write
 * that 500s. Heuristic (regex + brace-aware key extraction), so it has an
 * ALLOWLIST for unavoidable false positives (JSONB sub-keys, dynamic keys,
 * columns on non-public tables). Exit 1 on any un-allowlisted drift.
 *
 * Run: node scripts/qa/insert-column-drift-check.mjs   (needs DATABASE_URL)
 */
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { readEnv } from './qa-auth.mjs'

// (file:table:column) or (table:column) entries that are known-OK. Document why.
const ALLOWLIST = new Set([
  // mis-association: the .eq('author_id'/'author_handle') is on a `posts` query
  // variable (which HAS those cols), but a user_profiles .from() sits between the
  // query build and the .eq, so nearest-.from picks user_profiles wrongly.
  'lib/data/posts.ts:user_profiles:author_id',
  'lib/data/posts.ts:user_profiles:author_handle',
])

const SCAN_DIRS = ['app/api', 'lib/data']
const REPO = path.resolve(new URL('../..', import.meta.url).pathname)
const NON_RUNTIME_DIRS = new Set(['__mocks__', '__tests__'])

function walk(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!NON_RUNTIME_DIRS.has(e.name)) walk(p, acc)
    } else if (
      (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
      !/\.(?:spec|test)\.[cm]?tsx?$/.test(e.name)
    ) {
      acc.push(p)
    }
  }
  return acc
}

// Top-level object keys (identifiers/quoted strings at brace depth 0 of `body`).
// Skips nested objects/arrays (JSONB sub-keys), string/template contents, and
// non-identifier keys (numeric parse artifacts from spreads/computed keys).
function topKeys(body) {
  const keys = []
  let depth = 0
  let inStr = null
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (c === inStr && body[i - 1] !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 0 && c === ':') {
      let j = i - 1
      while (j >= 0 && /\s/.test(body[j])) j--
      const end = j + 1
      let start = j
      while (start >= 0 && /[\w'"$]/.test(body[start])) start--
      const key = body.slice(start + 1, end).replace(/['"]/g, '')
      // A real object key sits at a property boundary: the char before it (past
      // whitespace) is `{` or `,` or the start of the body. If it's anything
      // else (`?`, `(`, an operator …) this `:` is a TERNARY (`a ? b : c`) and
      // `b` is a value, not a column — skip it (was the quiz matchPercent FP).
      let b = start
      while (b >= 0 && /\s/.test(body[b])) b--
      const atBoundary = b < 0 || body[b] === '{' || body[b] === ','
      // real column identifiers only — drops numeric artifacts + computed keys
      if (atBoundary && key && /^[a-zA-Z_]\w*$/.test(key)) keys.push(key)
    }
  }
  return keys
}

// Balanced `{...}` body starting at the `{` index.
function objAfter(src, idx) {
  let depth = 0
  let inStr = null
  for (let i = idx; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === inStr && src[i - 1] !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(idx + 1, i)
    }
  }
  return null
}

// Extract top-level column names from a PostgREST `.select('...')` string.
// Skips `*`, embedded resources `rel(...)` (foreign tables, not columns of this
// table), json/cast ops, and resolves `alias:real_col` to the real column.
function selectColumns(sel) {
  if (!sel || sel.includes('*')) return []
  // split on top-level commas (respect parens of embedded resources)
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
    if (!p || p.includes('(')) continue // embedded resource rel(...) — not a column here
    if (p.includes(':')) p = p.split(':').pop().trim() // alias:real_col → real_col
    p = p.split('->')[0].split('::')[0].trim() // strip json ops / casts
    // `count` is the PostgREST count() aggregate (valid on any query), not a column
    if (p !== 'count' && /^[a-z_][a-z0-9_]*$/i.test(p)) out.push(p)
  }
  return out
}

async function main() {
  const dbUrl = readEnv('DATABASE_URL', { optional: true })
  if (!dbUrl) {
    // CI-safe: without prod DB access the guard cannot run. Skip (exit 0) rather
    // than fail so wiring this into CI never breaks the build before the
    // DATABASE_URL secret is configured. Set it to activate the hard gate.
    console.log(
      '⏭️  insert-column-drift-check SKIPPED — DATABASE_URL not set (set it to enable the gate)'
    )
    process.exit(0)
  }
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`
  )
  await client.end()
  const schema = {}
  for (const r of rows) (schema[r.table_name] ??= new Set()).add(r.column_name)

  const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO, d)))
  const reMethod = /\.(insert|update|upsert)\(\s*\[?\s*\{/g
  const findings = []
  const selectFindings = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = f.replace(REPO + '/', '')
    let m
    while ((m = reMethod.exec(src))) {
      // nearest preceding .from('table') in the same chain (within 600 chars)
      const before = src.slice(Math.max(0, m.index - 600), m.index)
      const froms = [...before.matchAll(/\.from\(\s*['"`](\w+)['"`]\s*\)/g)]
      if (!froms.length) continue
      const table = froms[froms.length - 1][1]
      if (!schema[table]) continue // view / non-public / RPC target — not checkable here
      const braceIdx = src.indexOf('{', m.index)
      const body = objAfter(src, braceIdx)
      if (!body) continue
      const cols = schema[table]
      const missing = [
        ...new Set(
          topKeys(body).filter(
            (k) =>
              !cols.has(k) &&
              !ALLOWLIST.has(`${rel}:${table}:${k}`) &&
              !ALLOWLIST.has(`${table}:${k}`)
          )
        ),
      ]
      if (missing.length) findings.push({ file: rel, table, method: m[1], missing })
    }

    // ---- read-path: .from('t').select('cols') columns must exist too ----
    const reSelect = /\.select\(\s*(['"`])([\s\S]*?)\1/g
    let s
    while ((s = reSelect.exec(src))) {
      const before = src.slice(Math.max(0, s.index - 400), s.index)
      const froms = [...before.matchAll(/\.from\(\s*['"`](\w+)['"`]\s*\)/g)]
      if (!froms.length) continue
      const table = froms[froms.length - 1][1]
      if (!schema[table]) continue
      const cols = schema[table]
      const missing = [
        ...new Set(
          selectColumns(s[2]).filter(
            (k) =>
              !cols.has(k) &&
              !ALLOWLIST.has(`${rel}:${table}:${k}`) &&
              !ALLOWLIST.has(`${table}:${k}`)
          )
        ),
      ]
      if (missing.length) selectFindings.push({ file: rel, table, missing })
    }

    // ---- filter/order: .order/.eq/.gt/... first arg is a column that must exist ----
    // (found manually: .order('updated_at') on trader_portfolio which has captured_at;
    //  posts .eq('user_id') which has author_id — export silently returned nothing)
    const reFilter = /\.(order|eq|neq|gt|gte|lt|lte|like|ilike|in)\(\s*(['"`])([a-z_][a-z0-9_]*)\2/g
    let ff
    while ((ff = reFilter.exec(src))) {
      const col = ff[3]
      const before = src.slice(Math.max(0, ff.index - 400), ff.index)
      const froms = [...before.matchAll(/\.from\(\s*['"`](\w+)['"`]\s*\)/g)]
      if (!froms.length) continue
      const table = froms[froms.length - 1][1]
      if (!schema[table]) continue
      if (
        !schema[table].has(col) &&
        !ALLOWLIST.has(`${rel}:${table}:${col}`) &&
        !ALLOWLIST.has(`${table}:${col}`)
      ) {
        selectFindings.push({ file: rel, table, missing: [`${ff[1]}(${col})`] })
      }
    }
  }

  const report = (list, verb, consequence) => {
    console.error(`\n❌ ${list.length} ${verb}:\n`)
    for (const f of list) {
      console.error(
        `  ${f.file}\n    ${f.method ? f.method + ' ' : 'select '}${f.table} → missing: ${f.missing.join(', ')}`
      )
    }
    console.error(consequence)
  }
  // Severity split: WRITE drift = 500 (data loss / broken mutation) → HARD FAIL.
  // READ drift = 400 (usually degrades to empty/handled) → ADVISORY warning,
  // unless STRICT_READS=1. This ships the gate green on the critical class now
  // while surfacing read-drift for per-case fixing without red-CI on the backlog.
  const strictReads = process.env.STRICT_READS === '1'
  if (findings.length)
    report(
      findings,
      'write(s) reference columns missing from production',
      `Each 500s at runtime (PGRST204). Fix = add the column via migration, OR correct the code` +
        ` (renamed/camelCase column, wrong table). False positives (JSONB sub-keys, dynamic keys) → ALLOWLIST.`
    )
  if (selectFindings.length) {
    if (strictReads) {
      report(
        selectFindings,
        'select(s) read columns missing from production',
        `Each 400s at runtime. Fix = correct the column name / add the column. FPs → ALLOWLIST.`
      )
    } else {
      console.warn(
        `\n⚠️  ${selectFindings.length} select(s) read columns missing from production (advisory — each 400s, usually` +
          ` degrades to empty; set STRICT_READS=1 to gate). Fix over time:`
      )
      for (const f of selectFindings)
        console.warn(`   ${f.file} — select ${f.table} → ${f.missing.join(', ')}`)
    }
  }
  if (findings.length || (strictReads && selectFindings.length)) process.exit(1)
  console.log(
    `\n✅ write-drift 0 (hard gate green)${selectFindings.length ? ` · ${selectFindings.length} read-drift advisory` : ' · read-drift 0'}`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error('[insert-column-drift-check] crashed:', e.message)
  process.exit(2)
})
