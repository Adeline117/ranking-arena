import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const clickhouseSchemaPath = 'scripts/clickhouse/schema.sql'

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '')
    .trim()
}

const clickhouseSchema = readSource(clickhouseSchemaPath)
const progress = readSource('docs/PROGRESS.md')
const runbook = readSource('docs/RUNBOOK.md')
const qaSource = readSource('scripts/qa/v1-clickhouse-schema-containment.test.mjs')

const forbiddenSqlSyntax =
  /\b(?:alter|analyze|as|begin|call|commit|copy|create|delete|drop|engine|execute|from|grant|group|insert|into|join|materialized|merge|order|partition|revoke|rollback|select|table|truncate|update|vacuum|view|where|with)\b/i

test('V1 ClickHouse schema artifact is a comment-only, non-executable tombstone', () => {
  assert.equal(
    stripSqlComments(clickhouseSchema),
    '',
    `${clickhouseSchemaPath} must contain comments only`
  )
  assert.doesNotMatch(
    clickhouseSchema,
    /\/\*|\*\//,
    `${clickhouseSchemaPath} must use line comments only`
  )
  assert.doesNotMatch(
    clickhouseSchema,
    forbiddenSqlSyntax,
    `${clickhouseSchemaPath} must not retain SQL or DDL operations`
  )

  for (const line of clickhouseSchema.split(/\r?\n/u)) {
    if (line.trim()) assert.match(line, /^--/, `${clickhouseSchemaPath} has non-comment content`)
  }

  assert.match(clickhouseSchema, /\[RETIRED\]/)
  assert.match(clickhouseSchema, /V1 NO-GO/)
  assert.match(clickhouseSchema, /ADR-023/)
  assert.match(clickhouseSchema, /comments are a no-op/i)
  assert.match(clickhouseSchema, /exit 0/)
  assert.match(clickhouseSchema, /not live-state evidence/)
})

test('ClickHouse schema containment is documented as a source-only boundary', () => {
  for (const document of [progress, runbook]) {
    assert.match(document, /V1 ClickHouse schema source (?:containment|boundary)/)
    assert.match(document, /`scripts\/clickhouse\/schema\.sql`/)
    assert.match(document, /source-only/)
    assert.match(document, /ClickHouse client/)
    assert.match(document, /dual-write/)
    assert.match(document, /PipelineLogger/)
    assert.match(document, /deployed ClickHouse instance/)
    assert.match(document, /host/)
    assert.match(document, /credential/)
    assert.match(document, /exit 0/)
    assert.match(document, /live-state/)
  }
})

test('ClickHouse schema containment QA is static and never launches a client', () => {
  const forbiddenQaRuntime = new RegExp(
    [
      ['node', 'child_process'].join(':'),
      ['spawn', '(?:Sync)?\\s*\\('].join(''),
      ['exec', '(?:Sync)?\\s*\\('].join(''),
    ].join('|')
  )
  const clickhouseClientCommand = ['clickhouse', 'client'].join('-')

  assert.doesNotMatch(qaSource, forbiddenQaRuntime)
  assert.doesNotMatch(qaSource, new RegExp(clickhouseClientCommand, 'i'))
})
