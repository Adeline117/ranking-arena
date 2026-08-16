import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationFile = '20260808010000_copier_snapshot_trust_raw_role.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationFile), 'utf8')
const proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/copier-snapshot-trust-raw-role.pg17.sh'),
  'utf8'
)
const sqlWithoutLineComments = migration.replace(/^\s*--.*$/gm, '')

describe('copier snapshot artifact@2 trust RAW role', () => {
  it('has one exact Supabase ledger identity after its reviewed predecessor', () => {
    const identity = migrationFile.match(/^(\d{14})_(.+)\.sql$/)
    expect(identity).not.toBeNull()
    expect(identity?.[1]).toBe('20260808010000')
    expect(identity?.[2]).toBe('copier_snapshot_trust_raw_role')
    expect('20260808010000' > '20260804054000').toBe(true)

    const sameVersion = readdirSync(join(process.cwd(), 'supabase/migrations')).filter((name) =>
      name.startsWith('20260808010000_')
    )
    expect(sameVersion).toEqual([migrationFile])

    expect(migration).toContain("ledger.name = 'publish_copier_snapshot_atomically'")
    expect(migration).not.toContain("ledger.version = '20260804054000'")
    expect(migration).toContain('858623049276963f644749fb0a660910967f1c51ac748dfe4f5556e38d69326b')
    expect(migration).toContain(
      'requires one exact publish_copier_snapshot_atomically migration ledger name and body'
    )
  })

  it('replaces only the exact reviewed role constraint and rejects same-name drift', () => {
    expect(migration).toContain('c8bce3447cb1b4456bb53e5cda9f82e00b4026ab2ed32d4a7305f2172bf5f8bd')
    expect(migration).toContain('b38e9396fc8e7198376dc261f8192fe48b636687796b9bc48f3c23dca24d21d8')
    expect(migration).toContain('raw_objects_metric_trust_binding has same-name drift')
    expect(migration).toContain(
      'copier snapshot trust RAW identity index already exists or has same-name drift'
    )
    expect(migration).not.toContain('NOT VALID')
    expect(migration).toContain('source_run_id IS NOT NULL')
    expect(migration).toContain('trust_artifact_role IS NOT NULL')
    expect(migration).toContain('half-bound legacy RAW trust rows must be quarantined')

    for (const role of [
      'source_payload',
      'population_manifest',
      'normalization_components',
      'event_history',
      'price_history',
      'opening_inventory',
      'copier_snapshot',
      'copier_snapshot_trust',
    ]) {
      expect(migration).toContain(`'${role}'`)
    }
  })

  it('makes the non-null outer artifact hash globally unique only for the new role', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uidx_raw_copier_snapshot_trust_per_run\s+ON arena\.raw_objects \(source_run_id\)\s+WHERE source_run_id IS NOT NULL\s+AND trust_artifact_role = 'copier_snapshot_trust';/
    )
    expect(migration).toContain('index_row.indisunique')
    expect(migration).toContain('index_row.indisvalid')
    expect(migration).toContain('index_row.indnkeyatts = 1')
    expect(migration).toContain("access_method.amname = 'btree'")
    expect(migration).not.toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?WHERE[\s\S]*?trust_artifact_role = 'copier_snapshot';/
    )
  })

  it('does not switch the old publisher or broaden RAW permissions', () => {
    expect(sqlWithoutLineComments).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+FUNCTION\s+arena\.publish_copier_snapshot\b/i
    )
    expect(sqlWithoutLineComments).not.toMatch(/\b(?:GRANT|REVOKE)\b/i)
    expect(sqlWithoutLineComments).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+POLICY\b/i)
    expect(sqlWithoutLineComments).not.toMatch(
      /ALTER\s+TABLE\s+arena\.raw_objects\s+(?:DISABLE|NO FORCE)\s+ROW LEVEL SECURITY/i
    )
    expect(sqlWithoutLineComments).not.toMatch(/\bUPDATE\s+arena\.raw_objects\b/i)
    expect(sqlWithoutLineComments).not.toMatch(/\bDELETE\s+FROM\s+arena\.raw_objects\b/i)
    expect(migration).toContain('private RAW row-security boundary is missing')
  })

  it('has executable PG17 proof for ledger, drift, uniqueness, legacy isolation, and ACLs', () => {
    for (const marker of [
      'wrong predecessor migration ledger naming',
      'drifted predecessor migration ledger body',
      'same-name drifted RAW role constraint',
      'half-bound legacy RAW trust row',
      'same-name drifted copier trust index',
      'same outer hash with different path and source',
      'legacy copier publisher definition and ACL',
      'legacy copier publisher contract',
      'browser role read RAW before trust role migration',
      'browser role read RAW after trust role migration',
      'RAW ACL/RLS/policy fingerprint',
      'new and legacy copier RAW populations',
      'new copier trust migration ledger naming drifted',
      'copier snapshot trust RAW role PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
