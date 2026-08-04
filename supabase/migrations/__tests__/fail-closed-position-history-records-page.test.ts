import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260804042000_fail_closed_position_history_records_page.sql'
  ),
  'utf8'
)
const priorMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260803090000_record_provenance_clocks.sql'),
  'utf8'
)
const proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/record-provenance-clocks.pg17.sh'),
  'utf8'
)

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function functionBody(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION ${name}(`
  const start = sql.indexOf(marker)
  if (start < 0) throw new Error(`function declaration not found: ${name}`)
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION ', start + marker.length)
  const declaration = sql.slice(start, next < 0 ? sql.length : next)
  const body = declaration.match(/\bAS\s+\$([a-zA-Z0-9_]*)\$([\s\S]*?)\$\1\$;/)?.[2]
  if (body === undefined) throw new Error(`function body not found: ${name}`)
  return body
}

function dollarConstant(name: string): string {
  const match = migration.match(
    new RegExp(`${name} constant text := \\$([a-z]+)\\$([\\s\\S]*?)\\$\\1\\$;`)
  )
  if (!match) throw new Error(`dollar-quoted transform constant not found: ${name}`)
  return match[2]
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1
}

const oldHash = '85ab861ceef850c6d19154c3c519d44326780cccfc6773002a108a75941388b3'
const targetHash = 'ccac40558ee03e98967fe74dd8380484d124fac06ccc18c0ddee14fef3730e7d'
const priorBody = functionBody(priorMigration, 'public.arena_records_page')
const anchor = dollarConstant('v_anchor')
const guard = dollarConstant('v_guard')
const historyMarker = dollarConstant('v_history_marker')
const ordersMarker = dollarConstant('v_orders_marker')

function applyDeclaredTransform(body: string): string {
  expect(occurrenceCount(body, anchor)).toBe(1)
  let transformed = body.replace(anchor, anchor + guard)
  const historyStart = transformed.indexOf(historyMarker)
  const ordersStart = transformed.indexOf(ordersMarker)
  expect(historyStart).toBeGreaterThan(0)
  expect(ordersStart).toBeGreaterThan(historyStart)
  transformed = transformed.slice(0, historyStart) + transformed.slice(ordersStart)
  return transformed
}

describe('position-history records-page database quarantine', () => {
  it('declares a single atomic, repeatable and idempotent callable cutover', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain('20260804-fail-closed-position-history-records-page')
    expect(migration).toContain('CREATE TEMP TABLE records_page_quarantine_snapshot')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.arena_records_page(')
    expect(migration).toContain('AS %L;')
    expect(migration).toContain('v_body_hash =')
    expect(migration).toContain('RETURN;')
  })

  it('accepts only the exact predecessor or target body and produces the pinned target', () => {
    expect(sha256(priorBody)).toBe(oldHash)
    const transformed = applyDeclaredTransform(priorBody)
    expect(sha256(transformed)).toBe(targetHash)
    expect(migration).toContain(oldHash)
    expect(migration).toContain(targetHash)
    expect(transformed).not.toContain('arena.position_history')
    expect(transformed).not.toContain("ELSIF p_kind = 'position_history' THEN")
  })

  it('returns empty unknown history before cursor parsing and preserves every other body byte', () => {
    const transformed = applyDeclaredTransform(priorBody)
    expect(guard).toContain("'rows', '[]'::pg_catalog.jsonb")
    expect(guard).toContain("'nextCursor', NULL::pg_catalog.text")
    expect(guard).toContain("'state', 'unknown'")
    expect(guard).toContain("'reason', 'history_evidence_not_bound'")
    for (const clock of ['asOf', 'sourceAsOf', 'observedAt', 'publishedAt']) {
      expect(guard).toContain(`'${clock}', NULL::pg_catalog.timestamptz`)
    }
    expect(transformed.indexOf(guard)).toBeLessThan(
      transformed.indexOf("IF p_cursor IS NOT NULL AND p_cursor <> '' THEN")
    )

    const reconstructed = transformed.replace(guard, '')
    const removedHistory = priorBody.slice(
      priorBody.indexOf(historyMarker),
      priorBody.indexOf(ordersMarker)
    )
    expect(reconstructed).toBe(priorBody.replace(removedHistory, ''))
  })

  it('preserves the callable OID/metadata and restores the exact public runtime ACL', () => {
    expect(migration).toContain('v_function IS DISTINCT FROM v_original_oid')
    for (const metadata of [
      "v_function_row.proowner <> 'postgres'::pg_catalog.regrole",
      'NOT v_function_row.prosecdef',
      "v_function_row.provolatile <> 's'",
      "v_language <> 'plpgsql'",
      "ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]",
    ]) {
      expect(migration).toContain(metadata)
    }
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration.match(/\bEXCEPT\b/g)).toHaveLength(4)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_records_page[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_records_page[\s\S]*?TO anon, authenticated, service_role;/
    )
  })

  it('ships executable PG17 evidence for direct roles, wrappers, cursors and replay', () => {
    for (const marker of [
      'legacy wrapper did not expose pre-cutover history',
      'position-history RPC quarantine drifted for role',
      'malformed history cursor escaped quarantine',
      'unknown trader no longer returns SQL NULL',
      'non-history RPC output changed during quarantine',
      'records callable OID changed during quarantine',
      'legacy wrapper bypassed quarantined callable',
      'position-history records-page quarantine replay drifted',
      'position-history records-page PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
