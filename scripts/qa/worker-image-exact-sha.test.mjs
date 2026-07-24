import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const imageWorkflow = readFileSync('.github/workflows/build-ingest-image.yml', 'utf8')
const deployGate = readFileSync('.github/workflows/deploy-gate.yml', 'utf8')
const dockerRunner = readFileSync('worker/docker-run-sg.sh', 'utf8')
const dockerCompose = readFileSync('worker/docker-compose.sg.yml', 'utf8')

test('builds a deployable worker image whenever deterministic runtime inputs change', () => {
  const pushTrigger = imageWorkflow.slice(
    imageWorkflow.indexOf('on:'),
    imageWorkflow.indexOf('concurrency:')
  )

  assert.match(pushTrigger, /push:\n    branches: \[main\]/)
  for (const path of [
    "'worker/**'",
    "'lib/**'",
    "'package.json'",
    "'package-lock.json'",
    "'.dockerignore'",
    "'.npmrc'",
    "'tsconfig.json'",
    "'scripts/ci/worker-release-id.mjs'",
    "'.github/workflows/build-ingest-image.yml'",
    "'.github/workflows/deploy-ingest-sg.yml'",
  ]) {
    assert.ok(pushTrigger.includes(path), `missing worker image trigger for ${path}`)
  }
  assert.match(imageWorkflow, /node scripts\/ci\/worker-release-id\.mjs "\$GITHUB_SHA"/)
  assert.doesNotMatch(imageWorkflow, /worker image source is not exact main/)
  assert.match(
    imageWorkflow,
    /tag="quarantine-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{GITHUB_SHA\}"/
  )
  assert.doesNotMatch(imageWorkflow, /\$\{\{ env\.IMAGE \}\}:latest/)
  assert.match(imageWorkflow, /\/app\/WORKER_RELEASE_ID/)
  assert.match(dockerRunner, /image release stamp mismatch/)
  assert.match(dockerCompose, /\$\{WORKER_RELEASE_ID:\?set WORKER_RELEASE_ID\}/)
  assert.doesNotMatch(dockerCompose, /:latest/)
  assert.match(deployGate, /ARENA_WORKER_RELEASE_ID="\$WORKER_RELEASE_ID"/)
  assert.match(deployGate, /node "\$RUNNER_TEMP\/worker-release-id\.mjs" "\$HEAD_SHA"/)
  assert.doesNotMatch(deployGate, /expected_(?:sha|release_id)=/)
  assert.match(deployGate, /steps\.worker_fleet\.outcome == 'success'/)
})

test('publishes only a quarantine tag until digest-level smoke succeeds', () => {
  const buildStart = imageWorkflow.indexOf('- name: Build + push quarantine image')
  const smokeStart = imageWorkflow.indexOf(
    '- name: Smoke quarantine digest — stamp + actual module loads'
  )
  const promoteStart = imageWorkflow.indexOf(
    '- name: Promote verified digest to release and SHA aliases'
  )

  assert.ok(buildStart > 0, 'missing quarantine build')
  assert.ok(smokeStart > buildStart, 'digest smoke must follow quarantine build')
  assert.ok(promoteStart > smokeStart, 'formal aliases must follow successful smoke')

  const preSmokeBuild = imageWorkflow.slice(buildStart, smokeStart)
  assert.match(preSmokeBuild, /tags: \$\{\{ steps\.quarantine\.outputs\.ref \}\}/)
  assert.doesNotMatch(preSmokeBuild, /^\s*tags:.*worker_release/m)
  assert.doesNotMatch(preSmokeBuild, /^\s*tags:.*github\.sha/m)

  const smoke = imageWorkflow.slice(smokeStart, promoteStart)
  assert.match(smoke, /digest_ref="\$\{IMAGE\}@\$\{DIGEST\}"/)
  assert.match(smoke, /docker run --rm --entrypoint cat/)
  assert.match(smoke, /await import\(m\)/)
  assert.match(smoke, /await import\('\.\/worker\/src\/ingest\/heartbeat\.ts'\)/)
  assert.doesNotMatch(smoke, /require\.resolve/)
  assert.doesNotMatch(smoke, /\|\| true/)
})

test('promotes the verified digest without overwriting conflicting formal aliases', () => {
  const promoteStart = imageWorkflow.indexOf(
    '- name: Promote verified digest to release and SHA aliases'
  )
  const recordStart = imageWorkflow.indexOf('- name: Upload digest deployment record')
  const promote = imageWorkflow.slice(promoteStart, recordStart)

  assert.match(promote, /docker buildx imagetools inspect "\$ref"/)
  assert.match(promote, /if \[\[ "\$existing" != "\$DIGEST" \]\]/)
  assert.match(promote, /refusing to overwrite \$ref/)
  assert.match(promote, /missing\+=\("\$ref"\)/)
  assert.match(
    promote,
    /docker buildx imagetools create "\$\{tag_args\[@\]\}" "\$\{IMAGE\}@\$\{DIGEST\}"/
  )
  assert.match(promote, /promoted_digest="\$\(inspect_digest "\$ref"\)"/)
  assert.match(promote, /worker-image-release\.json/)
  assert.match(promote, /digest_ref/)
  assert.match(imageWorkflow, /actions\/upload-artifact@v4/)
})
