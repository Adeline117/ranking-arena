import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260804041000_retire_legacy_position_history_publisher.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const publish = readFileSync(join(process.cwd(), 'lib/ingest/serving/publish.ts'), 'utf8')
const tierB = readFileSync(
  join(process.cwd(), 'worker/src/ingest/processors/tier-b-profiles.ts'),
  'utf8'
)
const tierC = readFileSync(
  join(process.cwd(), 'worker/src/ingest/processors/tier-c-profile.ts'),
  'utf8'
)
const manualSmoke = readFileSync(join(process.cwd(), 'scripts/ingest-test-surfaces.ts'), 'utf8')
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/verified-position-history-publication-writer.pg17.sh'
  ),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

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

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const writerBody = functionBody(migration, 'arena.publish_verified_position_history')
const rowGuardBody = functionBody(migration, 'arena.protect_verified_position_history_row')

describe('legacy position-history publisher retirement', () => {
  it('is an atomic PG17 cutover that preserves OIDs and exact trusted reader bodies', () => {
    const sql = withoutComments(migration)

    expect(sql.trimStart()).toMatch(/^BEGIN;/)
    expect(sql.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain('pg_advisory_xact_lock(')
    expect(migration).toContain('LOCK TABLE arena.position_history IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")

    expect(sql.match(/CREATE OR REPLACE FUNCTION/gi)).toHaveLength(2)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION arena\.publish_verified_position_history\(/i)
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION arena\.protect_verified_position_history_row\(/i
    )
    expect(sql).not.toMatch(/DROP FUNCTION/i)
    expect(sql).not.toMatch(/ALTER FUNCTION/i)
    expect(migration).toContain('legacy_position_history_retirement_functions')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(function_row.oid)')
    expect(migration).toContain('THEN NULL::text')
    expect(migration).toContain('snapshot.preserved_definition IS NOT NULL')
    expect(migration).toContain('legacy_position_history_retirement_triggers')
    expect(migration).toContain('legacy_position_history_retirement_relations')
    expect(migration).toContain('trigger_row.tgfoid IS DISTINCT FROM snapshot.tgfoid')
    expect(migration).toContain('trigger_row.tgfoid <> v_row_guard')
    expect(migration).toContain("trigger_row.tgenabled <> 'O'")
    expect(migration).toContain('31::smallint')
    expect(migration).toContain('34::smallint')
    expect(migration).toContain('guarded_relation.parent_relation_oid IS NULL')
    expect(migration).toMatch(/legacy_position_history_retirement_triggers\)\s*<>\s*1\s*\+\s*\(/)
    expect(migration).toContain('trigger_row.tgparentid IS DISTINCT FROM parent_trigger.oid')
    expect(migration).toContain('position-history guard trigger identity drifted before retirement')
  })

  it('attests the exact checkpoint/chain and refuses owner, checkpoint, or overload bypasses', () => {
    expect(migration).toContain(
      'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'
    )
    expect(migration).toContain(
      'arena.get_position_history_publication_checkpoint(smallint,bigint)'
    )
    expect(migration).toContain("function_row.proname = 'publish_verified_position_history'")
    expect(migration).toContain('legacy position-history writer overload set is not exact')
    expect(migration).toContain('pg_catalog.pg_has_role(')
    expect(migration).toContain("'MEMBER'")
    expect(migration).toContain('application role can assume a superuser or owner role')
    expect(migration).toContain('public application role can assume service_role')
    expect(migration).toContain('position-history checkpoint overload set is not exact')
    expect(migration).toContain('position-history chain guard overload set is not exact')

    expect(migration).toContain('440b079edbb8e8c45b60fc9032eec54cd6a3a220f2fa1847ae222c4844250ff0')
    expect(migration).toContain('ca6613267ec9e4b6fe8dbc579e2f49bc24e6918181fc9a844658882963383d67')
    expect(migration).toContain('FROM arena.record_surface_publications AS publication')
    expect(migration).toContain('arena.position_history_publication_chain_healthy(')
    expect(migration).toContain('WITH RECURSIVE publication_chain AS')
    expect(migration).toContain('LEFT JOIN arena.raw_objects AS raw_object')
    expect(migration).toContain(
      'position-history chain guard identity drifted before checkpoint grant'
    )
    expect(migration).toContain(
      "pg_catalog.strpos(function_row.prosrc, 'arena.ingest_cursors') = 0"
    )
    expect(migration).not.toContain('FROM pg_catalog.pg_depend')
  })

  it('replaces the old writer with an unconditional stub and freezes every typed write', () => {
    expect(sha256(writerBody)).toBe(
      'c6b9a4e5240227e308e25d2f83e08a89f2dc8c36c443ad54117aae052ab8e6a2'
    )
    expect(writerBody).toContain(
      'legacy position-history publisher is retired; parser-conservation receipt required'
    )
    for (const relation of [
      'arena.raw_objects',
      'arena.position_history',
      'arena.ingest_cursors',
    ]) {
      expect(writerBody).not.toContain(relation)
    }

    expect(sha256(rowGuardBody)).toBe(
      '727b58f09c7eb9bb241c39720e011fcfb1a1b2805aca5b8d75575c2380aebc36'
    )
    expect(rowGuardBody).toContain(
      'position-history insert requires parser-conservation publication authority'
    )
    expect(rowGuardBody).toContain("IF TG_OP = 'DELETE' THEN")
    expect(rowGuardBody).toContain("IF TG_OP = 'UPDATE' THEN")
    expect(rowGuardBody).not.toContain('RETURN NEW')
    expect(rowGuardBody).not.toContain('current_setting')
    expect(rowGuardBody).not.toContain('CURRENT_USER')
    expect(migration).toContain('59b3e439b972265f4a3c13951f6592db50d9a3411fc2fe63f1968b56292d6576')
    expect(migration).toContain('727b58f09c7eb9bb241c39720e011fcfb1a1b2805aca5b8d75575c2380aebc36')
  })

  it('removes every writer grant and restores exactly one non-grantable checkpoint grant', () => {
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain("pg_catalog.acldefault('f', function_row.proowner)")
    expect(migration).toContain('FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('FROM anon, authenticated, service_role CASCADE')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.get_position_history_publication_checkpoint\([\s\S]*?\) TO service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.publish_verified_position_history\(/
    )
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.protect_verified_position_history_row\(/
    )

    expect(migration).toContain("'service_role', v_writer, 'EXECUTE'")
    expect(migration).toContain("'anon', v_writer, 'EXECUTE'")
    expect(migration).toContain("'authenticated', v_writer, 'EXECUTE'")
    expect(migration).toContain('privilege.grantee <> function_row.proowner')
    expect(migration).toContain('privilege.grantor = function_row.proowner')
    expect(migration).toContain("privilege.privilege_type = 'EXECUTE'")
    expect(migration).toContain('NOT privilege.is_grantable')
    expect(migration).toContain('legacy position-history publisher retirement postflight failed')
  })

  it('removes every application and operator path to the old writer', () => {
    for (const source of [publish, tierB, tierC]) {
      expect(source).not.toContain('publishTierBVerifiedPositionHistoryInTransaction')
      expect(source).not.toContain('arena.publish_verified_position_history')
    }
    expect(publish).not.toContain('INSERT INTO arena.position_history')
    expect(publish).not.toContain('get_position_history_publication_checkpoint')
    expect(tierB).not.toContain('getPositionHistoryPublicationCheckpoint')
    expect(tierB).toContain('const cursor = null')
    expect(tierB).toContain('first trusted acquisition must be cursorless')
    expect(publish).toContain(
      "type CompatibilityHistoryKind = Exclude<HistoryKind, 'position_history' | 'copiers'>"
    )
    const guard = publish.indexOf("if (kind === 'position_history')")
    const emptyReturn = publish.indexOf('if (rows.length === 0) return 0', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(emptyReturn).toBeGreaterThan(guard)
    expect(publish).toContain('position_history requires parser-conservation publication')
    const copierGuard = publish.indexOf("if (kind === 'copiers')")
    const copierEmptyReturn = publish.indexOf('if (rows.length === 0) return 0', copierGuard)
    expect(copierGuard).toBeGreaterThan(-1)
    expect(copierEmptyReturn).toBeGreaterThan(copierGuard)
    expect(publish).toContain('copiers require snapshot-receipt publication')
    expect(publish).not.toContain('INSERT INTO arena.copier_records')

    expect(manualSmoke).toContain('buildCopierSnapshotArtifact({')
    expect(manualSmoke).toContain('writeCopierSnapshotRawArtifact(')
    expect(manualSmoke).toContain('publishCopierSnapshotInTransaction(transaction, {')
    expect(manualSmoke).not.toContain('publishHistoryRows')
    expect(manualSmoke).not.toContain('getHistoryCursor')
    expect(manualSmoke).not.toMatch(
      /for \(const kind of \[[^\]]*position_history[^\]]*\] as const\)/
    )
  })

  it('pins delegated ACL, owner-membership, wrapper, actual-call, and replay behavior in CI', () => {
    for (const proof of [
      'set-only-owner-membership',
      'inherit-owner-membership',
      'set-only-checkpoint-membership',
      'inherit-checkpoint-membership',
      'unsupported-writer-overload',
      'unsupported-checkpoint-overload',
      'disabled-guard-trigger-preflight',
      'disabled-child-guard-trigger-preflight',
      'rogue-guard-trigger-preflight',
      'tampered-chain-guard-preflight',
      'security-definer-wrapper-call',
      'security-definer-wrapper-retired',
      'retired-writer-owner',
      'service-null-receipt-insert',
      'owner-null-receipt-insert',
      'future-child-null-receipt-insert',
      'future-child-forged-receipt-insert',
      'owner-forged-receipt-insert',
      'legacy-null-receipt-update',
      'legacy-receipt-upgrade',
      'verified-receipt-rebind',
      'retired-verified-row-delete',
      'retired-position-history-truncate',
      'controlled legacy-row cleanup failed',
      'fixture_writer_rogue',
      'fixture_writer_delegate',
      'permission denied for function publish_verified_position_history',
      'CHECKPOINT_RETAINED',
      'idempotent retirement changed final ACL state',
    ]) {
      expect(pg17Proof).toContain(proof)
    }
    expect(packageJson).toContain('qa:retire-legacy-position-history-pg17')
    expect(ci).toContain('npm run qa:retire-legacy-position-history-pg17')
  })

  it('prevents any other migration, including backfills, from reopening the retired writer', () => {
    const allowed = new Set([
      '20260803101000_verified_position_history_publication_writer.sql',
      migrationName,
    ])
    const migrationDir = join(process.cwd(), 'supabase/migrations')
    const otherMigrations = readdirSync(migrationDir)
      .filter((name) => /^\d{14}_.+\.sql$/.test(name) && !allowed.has(name))
      .map((name) => ({
        name,
        sql: withoutComments(readFileSync(join(migrationDir, name), 'utf8')),
      }))

    for (const candidate of otherMigrations) {
      expect(candidate.sql).not.toMatch(/\bpublish_verified_position_history\b/i)
      expect(candidate.sql).not.toMatch(
        /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+arena\b/i
      )
    }
  })
})
