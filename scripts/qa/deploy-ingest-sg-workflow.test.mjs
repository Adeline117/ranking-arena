import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/deploy-ingest-sg.yml', 'utf8'))

// Trigger shape, `if: false`, absent secrets contract and action pinning are
// asserted for every workflow in workflow-secret-boundary / workflow-action-pinning.
test('SG deployment targets one required commit behind its protected environment', () => {
  assert.equal(workflow.on.workflow_call.inputs.target_sha.required, true)
  assert.equal(workflow.jobs['deploy-sg'].environment, 'ingest-sg-production')
  assert.deepEqual(workflow.jobs['deploy-sg'].needs, ['build-deps'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
})
