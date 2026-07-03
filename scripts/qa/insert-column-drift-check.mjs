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
 * This scanner extracts the object keys from every `.from('t').insert/update/
 * upsert({...})` in app/api + lib/data, and diffs them against the LIVE prod
 * column list (information_schema via DATABASE_URL). Any key not a real column
 * = a write that 500s. Heuristic (regex + brace-aware key extraction), so it
 * has an ALLOWLIST for the unavoidable false positives (JSONB sub-keys, dynamic
 * keys, columns on non-public tables). Exit 1 on any un-allowlisted drift.
 *
 * Run: node scripts/qa/insert-column-drift-check.mjs   (needs DATABASE_URL)
 */
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { readEnv } from './qa-auth.mjs'

// (file:table:column) or (table:column) entries that are known-OK. Document why.
const ALLOWLIST = new Set([
  // e.g. 'some_table:jsonb_subkey  // extracted from a nested JSONB literal',
])

const SCAN_DIRS = ['app/api', 'lib/data']
const REPO = path.resolve(new URL('../..', import.meta.url).pathname)

function walk(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(p)
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
      // real column identifiers only — drops numeric artifacts + computed keys
      if (key && /^[a-zA-Z_]\w*$/.test(key)) keys.push(key)
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

async function main() {
  const client = new pg.Client({
    connectionString: readEnv('DATABASE_URL'),
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
  }

  if (!findings.length) {
    console.log('✅ insert/update column-drift check passed — every written column exists in prod')
    process.exit(0)
  }
  console.error(`\n❌ ${findings.length} write(s) reference columns missing from production:\n`)
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.method} ${f.table} → missing: ${f.missing.join(', ')}`)
  }
  console.error(
    `\nEach 500s at runtime (PGRST204). Fix = add the column via migration, OR correct the` +
      ` code (renamed/camelCase column, wrong table). Genuine false positives (JSONB sub-keys,` +
      ` dynamic keys) → add to ALLOWLIST at the top with a reason.`
  )
  process.exit(1)
}

main().catch((e) => {
  console.error('[insert-column-drift-check] crashed:', e.message)
  process.exit(2)
})
