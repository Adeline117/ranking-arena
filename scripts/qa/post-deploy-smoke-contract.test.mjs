import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/post-deploy-smoke.yml'), 'utf8')

test('leaves enough bounded time for smoke, rollback, and notification', () => {
  assert.match(workflow, /timeout-minutes: 15/)
  assert.match(workflow, /--connect-timeout 5 --max-time 15/)
  assert.match(workflow, /--retry-max-time 40/)
  assert.match(workflow, /timeout 120s npx vercel@56\.2\.1 rollback --yes --timeout 90s/)
})

test('rolls back to Vercel previous production instead of READY list position', () => {
  assert.match(workflow, /VERCEL_ORG_ID: \$\{\{ secrets\.VERCEL_ORG_ID \}\}/)
  assert.match(workflow, /VERCEL_PROJECT_ID: \$\{\{ secrets\.VERCEL_PROJECT_ID \}\}/)
  assert.match(workflow, /FAILED_DEPLOYMENT_SHA: \$\{\{ github\.event\.deployment\.sha \}\}/)
  assert.match(workflow, /ROLLED_BACK="true"/)
  assert.doesNotMatch(workflow, /api\.vercel\.com\/v6\/deployments/)
  assert.doesNotMatch(workflow, /\.deployments\[1\]/)
  assert.doesNotMatch(workflow, /PREV_ID=/)
})

test('verifies rollback on the public health endpoint before claiming success', () => {
  assert.match(workflow, /arenafi\.org\/api\/health\?rollback_verify=/)
  assert.match(workflow, /--output \/tmp\/rollback-health\.json --write-out '%\{http_code\}'/)
  assert.match(workflow, /HEALTH_STATUS=\$\(jq -r '\.status \/\/ empty'/)
  assert.match(workflow, /SERVING_SHA=\$\(jq -r '\.commit \/\/ empty'/)
  assert.match(workflow, /\[ "\$HEALTH_HTTP" = "200" \]/)
  assert.match(workflow, /\[ "\$HEALTH_STATUS" = "healthy" \]/)
  assert.match(workflow, /\[\[ "\$SERVING_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  assert.match(workflow, /\[ "\$SERVING_SHA" != "\$FAILED_DEPLOYMENT_SHA" \]/)
  assert.match(workflow, /STABLE_HEALTHY_COUNT.*2/)

  const verifiedIndex = workflow.indexOf('ROLLED_BACK="true"')
  const healthConditionIndex = workflow.indexOf('[ "$HEALTH_STATUS" = "healthy" ]')
  assert.ok(healthConditionIndex >= 0)
  assert.ok(verifiedIndex > healthConditionIndex)
  assert.doesNotMatch(workflow, /Vercel confirmed rollback/)
})

test('makes both Telegram notification paths bounded and observable', () => {
  assert.equal(workflow.match(/send_telegram_alert\(\)/g)?.length, 2)
  assert.equal(workflow.match(/--connect-timeout 5 --max-time 10/g)?.length, 2)
  assert.equal(workflow.match(/--output \/dev\/null --write-out '%\{http_code\}'/g)?.length, 2)
  assert.equal(workflow.match(/::warning title=Telegram alert delivery failed::curl=/g)?.length, 2)
  assert.equal(workflow.match(/Telegram alert delivery failed — curl=/g)?.length, 2)
  assert.doesNotMatch(workflow, /api\.telegram\.org[^\n]*\$\{\{ secrets\./)
  assert.doesNotMatch(workflow, /api\.telegram\.org[^\n]*\|\| true/)
})

test('passes dynamic smoke output through the environment instead of shell interpolation', () => {
  assert.match(workflow, /SMOKE_FAIL: \$\{\{ steps\.smoke\.outputs\.fail \}\}/)
  assert.match(workflow, /SMOKE_TOTAL: \$\{\{ steps\.smoke\.outputs\.total \}\}/)
  assert.match(workflow, /SMOKE_FAILURES: \$\{\{ steps\.smoke\.outputs\.failures \}\}/)

  for (const runBlock of workflow.matchAll(
    /\n\s+run: \|\n([\s\S]*?)(?=\n\s+- name:|\n\s+- uses:|$)/g
  )) {
    assert.doesNotMatch(runBlock[1], /\$\{\{/)
  }
})
