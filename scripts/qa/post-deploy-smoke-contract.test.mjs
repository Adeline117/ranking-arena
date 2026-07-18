import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/post-deploy-smoke.yml'), 'utf8')

test('leaves enough bounded time for smoke, rollback, and notification', () => {
  assert.match(workflow, /timeout-minutes: 10/)
  assert.match(workflow, /--connect-timeout 5 --max-time 15/)
  assert.match(workflow, /--retry-max-time 40/)
  assert.match(workflow, /timeout 120s npx vercel@56\.2\.1 rollback --yes --timeout 90s/)
})

test('rolls back to Vercel previous production instead of READY list position', () => {
  assert.match(workflow, /VERCEL_ORG_ID: \$\{\{ secrets\.VERCEL_ORG_ID \}\}/)
  assert.match(workflow, /VERCEL_PROJECT_ID: \$\{\{ secrets\.VERCEL_PROJECT_ID \}\}/)
  assert.match(workflow, /ROLLED_BACK="true"/)
  assert.doesNotMatch(workflow, /api\.vercel\.com\/v6\/deployments/)
  assert.doesNotMatch(workflow, /\.deployments\[1\]/)
  assert.doesNotMatch(workflow, /PREV_ID=/)
})
