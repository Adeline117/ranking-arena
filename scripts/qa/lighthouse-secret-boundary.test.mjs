import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflowPath = '.github/workflows/lighthouse-ci.yml'
const workflow = readFileSync(workflowPath, 'utf8')
const parsed = parse(workflow)
const credentialExpression =
  /\b(?:secrets\s*(?:\.|\[\s*['"])|github\s*(?:\.token\b|\[\s*['"]token['"]\s*\]))/

test('credential matcher rejects dot and bracket GitHub expression syntax', () => {
  for (const expression of [
    '${{ secrets.PROD_KEY }}',
    "${{ secrets['PROD_KEY'] }}",
    '${{ github.token }}',
    '${{ github["token"] }}',
  ]) {
    assert.match(expression, credentialExpression)
  }
})

test('Lighthouse PR builds receive no repository or production secrets', () => {
  assert.doesNotMatch(workflow, credentialExpression)
  assert.deepEqual(parsed.permissions, { contents: 'read' })
  assert.equal(parsed.jobs.lighthouse.permissions, undefined)
  assert.equal(parsed.env.NEXT_PUBLIC_SUPABASE_URL, 'https://placeholder.supabase.co')
  assert.equal(parsed.env.SUPABASE_URL, 'https://placeholder.supabase.co')
  assert.match(parsed.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, /^ci-build-/)
  assert.match(parsed.env.SUPABASE_SERVICE_ROLE_KEY, /^ci-build-/)
})

test('repository commands cannot inherit a persisted, cached, or later write credential', () => {
  const checkout = parsed.jobs.lighthouse.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@')
  )
  assert.ok(checkout)
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  const setupNode = parsed.jobs.lighthouse.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/setup-node@')
  )
  assert.ok(setupNode)
  assert.equal(setupNode.with?.cache, undefined)
  const checkoutIndex = parsed.jobs.lighthouse.steps.indexOf(checkout)
  const firstRepositoryCommand = parsed.jobs.lighthouse.steps.findIndex(
    (step, index) => index > checkoutIndex && typeof step.run === 'string'
  )
  assert.ok(firstRepositoryCommand > checkoutIndex)
  for (const step of parsed.jobs.lighthouse.steps.slice(checkoutIndex + 1)) {
    assert.doesNotMatch(JSON.stringify(step), credentialExpression)
  }
  for (const step of parsed.jobs.lighthouse.steps.slice(firstRepositoryCommand)) {
    assert.equal(
      step.uses,
      undefined,
      'no action may be registered after repository-controlled commands begin'
    )
  }
  for (const step of parsed.jobs.lighthouse.steps.slice(
    checkoutIndex + 1,
    firstRepositoryCommand
  )) {
    if (step.uses) assert.match(step.uses, /^actions\/setup-node@[0-9a-f]{40}$/)
  }
})

test('every Lighthouse third-party action is pinned to an immutable commit', () => {
  const actions = parsed.jobs.lighthouse.steps
    .map((step) => step.uses)
    .filter((value) => typeof value === 'string')
  assert.ok(actions.length > 0)
  for (const action of actions) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/)
})
