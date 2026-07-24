import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260724232500_allow_pipeline_logs_partial_success.sql'),
  'utf8'
)
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

describe('pipeline_logs status schema contract', () => {
  it('allows every lifecycle status emitted by PipelineLogger', () => {
    const emittedStatuses = [
      ...pipelineLogger.matchAll(/status: '(running|success|partial_success|error|timeout)'/g),
    ].map((match) => match[1])

    expect(new Set(emittedStatuses)).toEqual(
      new Set(['running', 'success', 'partial_success', 'error', 'timeout'])
    )
    for (const status of new Set(emittedStatuses)) {
      expect(migration).toContain(`'${status}'`)
    }
  })

  it('replaces the constraint atomically after the v2 constraint is validated', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("SET LOCAL lock_timeout = '15s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toMatch(
      /ADD CONSTRAINT pipeline_logs_status_check_v2[\s\S]*CHECK \(status IN \('running', 'success', 'partial_success', 'error', 'timeout'\)\)[\s\S]*NOT VALID;/
    )

    const addV2 = migration.indexOf('ADD CONSTRAINT pipeline_logs_status_check_v2')
    const validateV2 = migration.indexOf('VALIDATE CONSTRAINT pipeline_logs_status_check_v2')
    const dropOld = migration.indexOf('DROP CONSTRAINT pipeline_logs_status_check;')
    const renameV2 = migration.indexOf(
      'RENAME CONSTRAINT pipeline_logs_status_check_v2 TO pipeline_logs_status_check;'
    )
    const commit = migration.indexOf('COMMIT;')

    expect(addV2).toBeGreaterThan(-1)
    expect(validateV2).toBeGreaterThan(addV2)
    expect(dropOld).toBeGreaterThan(validateV2)
    expect(renameV2).toBeGreaterThan(dropOld)
    expect(commit).toBeGreaterThan(renameV2)
  })
})
