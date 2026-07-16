#!/usr/bin/env node
/**
 * Supabase typed-client bypass ratchet.
 *
 * `getSupabaseAdmin()` returns `SupabaseClient<Database>` — a client typed against
 * the generated prod schema, so writing/reading a column that doesn't exist is a
 * COMPILE error. But two casts strip that typing and let column drift compile
 * (the root enabler of the 2026-07 drift class — groups.slug, the whole Stripe
 * webhook sync, etc. all 500'd because their write sites were untyped):
 *   1. `... as SupabaseClient`   (bare, no `<Database>` generic → untyped)
 *   2. `... as any`  on a `.from()/.rpc()` line
 *
 * CLAUDE.md forbids these ("禁 as any / as SupabaseClient 绕过生成类型") but there is
 * a large existing backlog, so this is a RATCHET (like the design-token ratchet):
 * the count may only go DOWN. New code cannot add a bypass; every removal (which
 * restores `<Database>` typing and lets tsc catch drift) lowers the ceiling.
 *
 * Fix a violation by dropping the cast so the client stays `SupabaseClient<Database>`,
 * then fix whatever tsc errors it reveals (those are real latent column drift).
 * After reducing, lower BASELINE to the new count to lock in the progress.
 */
import fs from 'node:fs'
import path from 'node:path'

// Ceiling — the count may only decrease. Lower this after removing casts.
// 2026-07-16 baseline: 177 typed-client bypasses (the root enabler of the
// 2026-07 column-drift class). Drive this down; never let it grow.
const BASELINE = 177

const REPO = path.resolve(new URL('../..', import.meta.url).pathname)
const DIRS = ['app', 'lib']

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
      if (e.name === 'node_modules' || e.name === '.next') continue
      walk(p, acc)
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(p)
  }
  return acc
}

const files = DIRS.flatMap((d) => walk(path.join(REPO, d)))
const hits = []
for (const f of files) {
  const rel = f.replace(REPO + '/', '')
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // bare `as SupabaseClient` (NOT `as SupabaseClient<...>`) — strips <Database>
    const bareCast = /\bas SupabaseClient\b/.test(line) && !/\bas SupabaseClient</.test(line)
    // `as any` on a DB-call line
    const anyOnDb = /\bas any\b/.test(line) && /\.(from|rpc)\(/.test(line)
    if (bareCast || anyOnDb) hits.push(`${rel}:${i + 1}`)
  })
}

const count = hits.length
if (count > BASELINE) {
  console.error(
    `\n❌ Supabase typed-client bypass ratchet: ${count} > baseline ${BASELINE} (+${count - BASELINE}).`
  )
  console.error(
    `   New \`as SupabaseClient\`(bare) / \`as any\`-on-.from/.rpc strips <Database> typing and lets`
  )
  console.error(`   column drift compile. Drop the cast (keep SupabaseClient<Database>) instead.\n`)
  // show the newest-looking ones (best-effort: just list a sample)
  for (const h of hits.slice(0, 12)) console.error(`   ${h}`)
  if (hits.length > 12) console.error(`   … (+${hits.length - 12})`)
  process.exit(1)
}
console.log(
  `✅ Supabase typed-client bypass ratchet: ${count} ≤ baseline ${BASELINE}` +
    (count < BASELINE
      ? ` — lower BASELINE to ${count} to lock in the ${BASELINE - count} removed.`
      : '')
)
process.exit(0)
