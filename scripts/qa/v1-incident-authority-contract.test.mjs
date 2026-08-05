import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildLaunchMigrationInventory } from './launch-migration-inventory.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const documents = Object.freeze({
  beta: read('docs/V1_BETA_OPERATING_RUNBOOK_2026-08-03.md'),
  managed: read('docs/V1_MANAGED_SCRATCH_REQUEST_2026-08-04.md'),
  product: read('docs/V1_PRODUCT_STATUS_AND_PLAN_2026-08-03.md'),
  runbook: read('docs/RUNBOOK.md'),
  staging: read('docs/STAGING.md'),
  status: read('docs/V1_EXECUTION_STATUS_2026-08-04.md'),
})

function predeployCount() {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const phase = inventory.phases.find((candidate) => candidate.name === 'predeploy')
  assert.ok(phase, 'predeploy inventory phase is missing')
  return phase.count
}

function assertOrdered(source, labels) {
  let previous = -1
  for (const label of labels) {
    const index = source.indexOf(label)
    assert.notEqual(index, -1, `missing ordered incident gate: ${label}`)
    assert.ok(index > previous, `incident gate is out of order: ${label}`)
    previous = index
  }
}

function assertLegacyCountsAreHistorical(source, documentName) {
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/\b(?:114|51|64)\b/gu)) {
      assert.match(
        line,
        /历史|当时|下界|旧计数|不能沿用/u,
        `${documentName} must qualify legacy count ${match[0]} as historical`
      )
    }
  }
}

test('operational documents defer runtime facts to the current incident authority', () => {
  for (const [name, source] of Object.entries({
    beta: documents.beta,
    product: documents.product,
    runbook: documents.runbook,
    staging: documents.staging,
  })) {
    assert.match(
      source,
      /V1_EXECUTION_STATUS_2026-08-04\.md/u,
      `${name} must link the current incident authority`
    )
    assert.doesNotMatch(
      source,
      /V1_EXECUTION_STATUS_2026-08-03\.md/u,
      `${name} must not direct operators to the superseded status`
    )
  }
})

test('token containment is current while production remains NO-GO', () => {
  for (const [name, source] of Object.entries(documents)) {
    assert.doesNotMatch(
      source,
      /ACTIVE-EXPOSURE/u,
      `${name} must not contain the superseded exposure label`
    )
  }
  for (const [name, source] of Object.entries({
    beta: documents.beta,
    product: documents.product,
    runbook: documents.runbook,
  })) {
    assert.doesNotMatch(
      source,
      /当前 legacy token-ranking(?:\s|\n)+surface 是 \*\*ACTIVE-EXPOSURE\*\*/u,
      `${name} must not revive the remediated ACTIVE-EXPOSURE claim`
    )
    assert.match(source, /5ed4718b67ad78c42fd919dfe1f6508221893916|5ed4718b6/u)
    assert.match(source, /NO-GO/u)
  }
})

test('runbooks derive the current predeploy size and label old counts as historical', () => {
  const count = predeployCount()
  assert.equal(count, 122)
  for (const [name, source] of Object.entries({
    beta: documents.beta,
    product: documents.product,
    runbook: documents.runbook,
  })) {
    assert.match(
      source,
      new RegExp(`(?:当前|current).*\\b${count}\\b|\\b${count}\\b.*(?:当前|current)`, 'u')
    )
    assert.match(source, /历史[^\n]{0,120}(?:114|51|64)|(?:114|51|64)[^\n]{0,120}历史/u)
    assert.doesNotMatch(
      source,
      /(?:当前|current)[^。\n]{0,40}(?:manifest|清单)[^。\n]{0,24}`?114`?/iu
    )
    assertLegacyCountsAreHistorical(source, name)
  }
  assert.match(documents.runbook, /不能把 `51` 写成当前精确缺项数/u)
  assert.match(documents.product, /当前精确缺项数未知/u)
})

test('canonical baseline and both clean restore cycles precede migration planning', () => {
  const runbookGate = documents.runbook.slice(
    documents.runbook.indexOf('Canonical baseline 上游门禁')
  )
  const productRecovery = documents.product.slice(
    documents.product.indexOf('### 阶段 2：恢复与发布')
  )
  assertOrdered(runbookGate, [
    'Canonical baseline 上游门禁',
    '2026-07-26',
    '当前 completion metadata',
    'source witness',
    '两个空白 managed PG17',
    '当前 122 项 predeploy manifest',
    'V1 完整十六迁移数据库门禁',
  ])
  assertOrdered(productRecovery, [
    '托管事故恢复',
    '2026-07-26 legacy 对象',
    '当前 completion metadata',
    'source witness',
    '两个独立空白 managed PG17',
    '当前 122 项 predeploy manifest',
  ])
  assert.match(documents.beta, /2026-07-26[^\n]+当前-contract 新备份/u)
  assert.match(documents.beta, /source capture[^\n]+canonical baseline/u)
  assert.match(documents.beta, /两个独立 managed PG17/u)
  assert.match(documents.managed, /two\s+clean restore cycles/u)
  assert.match(documents.managed, /never overwrite the legacy\s+restore/u)
  assertOrdered(documents.status.slice(documents.status.indexOf('## 剩余门禁')), [
    '2026-07-26 legacy 对象',
    '当前 completion metadata',
    '新的干净',
    '不得覆盖 legacy restore 或混用证据',
  ])
  assertOrdered(documents.managed.slice(documents.managed.indexOf('## Execution order')), [
    '2026-07-26 legacy object',
    'current-contract backup',
    'capture-canonical-baseline.mjs',
    'candidate/not-deployable',
    'empty managed PG17 projects',
  ])
  assert.match(documents.runbook, /`040440` 更不能机械紧跟 `040430`/u)
  assert.doesNotMatch(
    documents.runbook,
    /5\. `20260804043000_retire_legacy_token_rankings\.sql`\s+6\. `20260804044000/u
  )
})

test('staging containment is not misreported as a qualified deployment path', () => {
  assert.match(
    documents.staging,
    /generic(?:\s|>)+Vercel Preview\/Development high-privilege variables were cleared/u
  )
  assert.match(documents.staging, /did not create a qualified staging/u)
  assert.doesNotMatch(documents.staging, /npx vercel env add/u)
  assert.doesNotMatch(documents.staging, /git push origin staging/u)
  assert.doesNotMatch(documents.staging, /\bvercel deploy\b/u)
  assert.doesNotMatch(documents.staging, /\bvercel --prod\b/u)
  assert.doesNotMatch(documents.staging, /current project\s+has production credentials in Preview/u)
})

test('workflow and Telegram control-plane evidence keeps the consumer boundary closed', () => {
  assert.match(
    documents.runbook,
    /all 17 repository-defined(?:\s|>)+workflows are also `disabled_manually`/u
  )
  assert.doesNotMatch(documents.runbook, /all 16 repository/u)
  assert.match(documents.runbook, /TELEGRAM_BOT_TOKEN/u)
  assert.match(documents.runbook, /TELEGRAM_ALERT_CHAT_ID/u)
  assert.match(documents.runbook, /尚无真实 `sendMessage` 成功证明/u)
  assert.match(documents.status, /17 个 repository-defined workflow 全部为 `disabled_manually`/u)
  assert.match(documents.status, /non-completed run 为 0/u)
})
