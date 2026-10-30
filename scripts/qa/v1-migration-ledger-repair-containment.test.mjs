import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ledgerRepairPath = 'scripts/migration-reconcile/ledger-repair-20260702.sql'

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '')
    .trim()
}

const ledgerRepair = readSource(ledgerRepairPath)
const driftAudit = readSource('docs/MIGRATION_DRIFT_AUDIT_2026-07-02.md')
const progress = readSource('docs/PROGRESS.md')
const runbook = readSource('docs/RUNBOOK.md')

const forbiddenSqlOperations =
  /\b(?:alter|analyze|begin|call|commit|copy|create|delete|drop|execute|grant|insert|merge|revoke|rollback|select|truncate|update|vacuum|with)\b/i

test('V1 migration-ledger repair artifact is a comment-only non-executable tombstone', () => {
  assert.equal(stripSqlComments(ledgerRepair), '', `${ledgerRepairPath} must contain comments only`)
  assert.doesNotMatch(ledgerRepair, /\/\*|\*\//, `${ledgerRepairPath} must use line comments only`)
  assert.doesNotMatch(
    ledgerRepair,
    forbiddenSqlOperations,
    `${ledgerRepairPath} must not retain SQL operations`
  )

  for (const line of ledgerRepair.split(/\r?\n/u)) {
    if (line.trim()) assert.match(line, /^--/, `${ledgerRepairPath} has non-comment content`)
  }

  assert.match(ledgerRepair, /\[RETIRED\]/)
  assert.match(ledgerRepair, /V1 NO-GO/)
  assert.match(ledgerRepair, /ADR-023/)
  assert.match(ledgerRepair, /comments are a no-op/)
  assert.match(ledgerRepair, /exit 0/)
  assert.match(ledgerRepair, /not live-state evidence/)
})

test('migration drift audit retains history without a runnable ledger or recovery path', () => {
  const retiredArtifactStart = driftAudit.indexOf('## 四、已退役的历史产物')
  const futureBoundaryStart = driftAudit.indexOf('## 五、未来边界')
  const retiredArtifact = driftAudit.slice(retiredArtifactStart, futureBoundaryStart)

  assert.ok(retiredArtifactStart >= 0)
  assert.ok(futureBoundaryStart > retiredArtifactStart)
  assert.match(retiredArtifact, new RegExp(ledgerRepairPath.replaceAll('.', '\\.'), 'u'))
  assert.match(retiredArtifact, /\[RETIRED\]/)
  assert.match(retiredArtifact, /纯注释/)
  assert.match(retiredArtifact, /exit 0/)
  assert.match(retiredArtifact, /live-state.*证据/u)

  assert.doesNotMatch(
    driftAudit,
    /execute_sql|\bpsql\b|DATABASE_URL|migration repair|supabase db push|\bDELETE\b/i
  )
  assert.doesNotMatch(driftAudit, /```(?:bash|sh|shell|zsh)/i)
  assert.doesNotMatch(retiredArtifact, /\b(?:less|node|supabase)\s+/i)
})

test('V1 documentation bounds the retired artifact to source-only, non-live-state evidence', () => {
  assert.match(progress, /V1 migration-ledger repair artifact source containment/)
  assert.match(runbook, /Retired migration-ledger repair artifact — V1 NO-GO/)

  for (const document of [progress, runbook]) {
    assert.match(document, new RegExp(ledgerRepairPath.replaceAll('.', '\\.'), 'u'))
    assert.match(document, /source-only boundary/)
    assert.match(document, /live-state/)
    assert.match(document, /ADR-023/)
    assert.match(document, /exit 0/)
  }
})
