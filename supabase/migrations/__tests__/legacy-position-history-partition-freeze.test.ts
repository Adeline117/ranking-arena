import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260804044000_freeze_legacy_position_history_relations.sql'
const migrationDir = join(process.cwd(), 'supabase/migrations')
const migration = readFileSync(join(migrationDir, migrationName), 'utf8')
const proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/legacy-position-history-partition-freeze.pg17.sh'
  ),
  'utf8'
)

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

function functionBody(sql: string, name: string): string {
  const declaration = sql.match(
    new RegExp(
      `CREATE(?: OR REPLACE)? FUNCTION ${name.replaceAll('.', '\\.')}` +
        `[\\s\\S]*?\\bAS \\$function\\$([\\s\\S]*?)\\$function\\$`
    )
  )
  if (!declaration) throw new Error(`function declaration not found: ${name}`)
  return declaration[1]
}

const guardBody = functionBody(migration, 'public.reject_legacy_position_history_mutation')
const creatorBody = functionBody(migration, 'public.create_next_tph_partition')

describe('legacy trader-position-history relation freeze', () => {
  it('discovers and locks every ledger, manual-cutover, descendant, and orphan shape', () => {
    const sql = withoutComments(migration)

    expect(sql.trimStart()).toMatch(/^BEGIN;/)
    expect(sql.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain('20260804-freeze-legacy-position-history-relations')
    expect(migration).toContain('WITH RECURSIVE named_root(root_oid) AS')
    expect(migration).toContain("'trader_position_history_partitioned'")
    expect(migration).toContain("'trader_position_history_old'")
    expect(migration).toContain("relation.relname LIKE 'tph\\_%' ESCAPE '\\'")
    expect(migration).toContain('JOIN pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain('parent_relation_oid')
    expect(migration).toContain('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE ONLY %I.%I IN SHARE ROW EXCLUSIVE MODE')
    expect(migration.indexOf('DO $lock_named_roots$')).toBeLessThan(
      migration.indexOf('WITH RECURSIVE named_root(root_oid) AS')
    )
    expect(migration).toContain('legacy position-history named root identity changed while locking')
    expect(migration).toContain(
      'legacy position-history canonical or side-by-side parent is missing'
    )
    expect(migration).toContain(
      'legacy position-history partition ancestry escaped the guarded set'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('rejects unsafe role membership, object kinds, owners, and trigger identities', () => {
    expect(migration).toContain('pg_catalog.pg_has_role(')
    expect(migration).toContain("'MEMBER'")
    expect(migration).toContain('application role can assume a superuser or legacy relation owner')
    expect(migration).toContain('public application role can assume service_role')
    expect(migration).toContain('runtime application role can create in public schema')
    expect(migration).toContain('pg_catalog.has_schema_privilege(')
    expect(migration).toContain(
      "guarded_relation.relation_owner <>\n            'postgres'::pg_catalog.regrole"
    )
    expect(migration).toContain("guarded_relation.relation_kind NOT IN ('r', 'p')")
    expect(migration).toContain('reserved tph relation has invalid kind')
    expect(migration).toContain('row_trigger.tgenabled <>')
    expect(migration).toContain('row_trigger.tgparentid <> parent_row_trigger.oid')
    expect(migration).toContain('31::smallint')
    expect(migration).toContain('34::smallint')
    expect(migration).toContain('legacy position-history row guard identity drifted')
    expect(migration).toContain('frozen legacy position-history RLS policy drifted')
  })

  it('collapses table and column delegation to one non-grantable service read', () => {
    expect(migration).toContain("pg_catalog.acldefault('r', relation.relowner)")
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE')
    expect(migration).toContain('FROM %I CASCADE')
    expect(migration).toContain('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), ')
    expect(migration).toContain('GRANT SELECT ON TABLE %I.%I TO service_role')
    expect(migration).toContain('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('CREATE POLICY legacy_position_history_operator_read')
    expect(migration).toContain('TO postgres, service_role USING (true)')
    expect(migration).toContain("acl_entry.privilege_type <> 'SELECT'")
    expect(migration).toContain('OR acl_entry.is_grantable')

    for (const role of ['service_role', 'anon', 'authenticated']) {
      expect(migration).toContain(`'${role}',`)
    }
    expect(migration).toContain("'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'")
  })

  it('installs a pinned unconditional owner-proof I/U/D/TRUNCATE guard', () => {
    expect(sha256(guardBody)).toBe(
      '52a394d55deb0f1d92143e252ac0a2dcdcc22c3a2985863a9ec296199dfc0a58'
    )
    expect(guardBody).toContain(
      'legacy trader position history is frozen; parser-conservation projection required'
    )
    expect(guardBody).not.toContain('RETURN NEW')
    expect(guardBody).not.toContain('CURRENT_USER')
    expect(guardBody).not.toContain('current_setting')

    expect(migration).toContain('CREATE TRIGGER reject_legacy_position_history_before_write')
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE ON %I.%I')
    expect(migration).toContain('CREATE TRIGGER reject_legacy_position_history_before_truncate')
    expect(migration).toContain('BEFORE TRUNCATE ON %I.%I')
    expect(migration).toContain(
      'A child attached after the first freeze inherits the exact row guard'
    )
    expect(migration).toContain('trigger_row.tgparentid = v_parent_row_trigger')
    expect(migration).toContain('truncate_trigger.tgparentid <> 0')
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain("function_row.prorettype =\n                 'pg_catalog.trigger'")
  })

  it('retires the old partition creator in place and leaves no callable bypass', () => {
    expect(sha256(creatorBody)).toBe(
      '59aa806f207b9c6c68ab9aaf61cb5c7340fe6e6fe5345186cb319d7abc7fb999'
    )
    expect(creatorBody).toContain('legacy trader position-history partition creator is retired')
    expect(creatorBody).not.toContain('CREATE TABLE')
    expect(creatorBody).not.toContain('GRANT')

    expect(migration).toContain(
      'CREATE TEMP TABLE legacy_position_history_partition_creator_snapshot'
    )
    expect(migration).toContain('v_creator_count = 1')
    expect(migration).toContain('v_creator IS NULL')
    expect(migration).toContain('partition creator overload set drifted')
    expect(migration).toContain("'public.create_next_tph_partition()'")
    expect(migration).toContain('legacy partition creator OID changed during retirement')
    expect(migration).toContain("pg_catalog.acldefault('f', function_row.proowner)")
    expect(migration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.create_next_tph_partition/i
    )
    expect(migration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.reject_legacy_position_history_mutation/i
    )
  })

  it('ships PG17 evidence for hostile topology, wrappers, future children, rename, and replay', () => {
    for (const marker of [
      'public-service-membership',
      'service-owner-membership',
      'runtime-public-schema-create',
      'wrong-relation-owner',
      'single-wrong-signature-creator',
      'rogue-existing-trigger',
      'anon-direct-child-insert',
      'owner-flat-insert',
      'owner-child-update',
      'owner-child-delete',
      'owner-orphan-truncate',
      'security-definer-dynamic-wrapper',
      'regranted-anon-insert-hits-guard',
      'disabled-child-row-guard',
      'public-policy-replay-drift',
      'serialize a committing concurrent partition before discovery',
      'concurrent-child-row-guard-before-replay',
      'concurrent-child-truncate-guard-before-replay',
      'runtime-future-child-create-disabled',
      'runtime-future-child-attach-disabled',
      'prove byte/OID-stable replay',
      'prove manual rename cutover topology',
      'prove optional old parent and creator may be absent',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('prevents later migrations from reopening legacy direct authority', () => {
    const laterMigrations = readdirSync(migrationDir)
      .filter((name) => /^\d{14}_.+\.sql$/.test(name) && name > migrationName)
      .map((name) => ({
        name,
        sql: withoutComments(readFileSync(join(migrationDir, name), 'utf8')),
      }))

    for (const candidate of laterMigrations) {
      expect({
        migration: candidate.name,
        reopensPartitionCreator: /\bcreate_next_tph_partition\b/i.test(candidate.sql),
        grantsLegacyRelation:
          /GRANT\s+[\s\S]{0,180}\b(?:trader_position_history(?:_partitioned|_old)?|tph_[a-zA-Z0-9_]+)\b/i.test(
            candidate.sql
          ),
        dropsFreezeTrigger:
          /DROP\s+TRIGGER\s+(?:reject_legacy_position_history_before_write|reject_legacy_position_history_before_truncate)\b/i.test(
            candidate.sql
          ),
      }).toEqual({
        migration: candidate.name,
        reopensPartitionCreator: false,
        grantsLegacyRelation: false,
        dropsFreezeTrigger: false,
      })
    }
  })
})
