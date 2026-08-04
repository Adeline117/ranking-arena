import assert from 'node:assert/strict'
import test from 'node:test'
import { findDangerousDdl } from './migration-dangerous-ddl-check.mjs'

test('detects destructive table and column drops', () => {
  const findings = findDangerousDdl(`
    DROP TABLE IF EXISTS public.old_table;
    ALTER TABLE public.accounts DROP COLUMN legacy_name;
  `)

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['DROP TABLE', 'DROP COLUMN']
  )
})

test('detects multiline ALTER COLUMN SET NOT NULL', () => {
  const findings = findDangerousDdl(`
    ALTER TABLE public.claims
      ALTER COLUMN owner_id
      SET NOT NULL;
  `)

  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'ALTER COLUMN SET NOT NULL')
  assert.equal(findings[0].line, 2)
})

test('does not treat comments or safe additive DDL as destructive', () => {
  const findings = findDangerousDdl(`
    -- DROP TABLE public.example;
    /* ALTER TABLE public.example
       ALTER COLUMN value SET NOT NULL; */
    ALTER TABLE public.claims
      ADD COLUMN submission_version smallint NOT NULL DEFAULT 1;
  `)

  assert.deepEqual(findings, [])
})

test('handles nested block comments without exposing commented DDL', () => {
  const findings = findDangerousDdl(`
    /* outer
      /* DROP COLUMN nested_value */
      DROP TABLE public.hidden;
    */
    CREATE TABLE public.visible (id bigint PRIMARY KEY);
  `)

  assert.deepEqual(findings, [])
})
