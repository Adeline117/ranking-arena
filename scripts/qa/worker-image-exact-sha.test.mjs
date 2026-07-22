import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const imageWorkflow = readFileSync('.github/workflows/build-ingest-image.yml', 'utf8')
const deployGate = readFileSync('.github/workflows/deploy-gate.yml', 'utf8')

test('builds a deployable worker image for every exact main release SHA', () => {
  const pushTrigger = imageWorkflow.slice(
    imageWorkflow.indexOf('on:'),
    imageWorkflow.indexOf('concurrency:')
  )

  assert.match(pushTrigger, /push:\n    branches: \[main\]/)
  assert.doesNotMatch(pushTrigger, /\n\s+paths(?:-ignore)?:/)
  assert.match(imageWorkflow, /\$\{\{ env\.IMAGE \}\}:\$\{\{ github\.sha \}\}/)
  assert.match(deployGate, /expected_sha=\$HEAD_SHA/)
  assert.match(deployGate, /steps\.worker_fleet\.outcome == 'success'/)
})
