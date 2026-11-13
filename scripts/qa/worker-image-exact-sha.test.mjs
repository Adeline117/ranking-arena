import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const imageWorkflow = readFileSync('.github/workflows/build-ingest-image.yml', 'utf8')
const deployGate = readFileSync('.github/workflows/deploy-gate.yml', 'utf8')
const ingestDockerfile = readFileSync('worker/Dockerfile.ingest', 'utf8')
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
  assert.doesNotMatch(imageWorkflow, /\$\{\{ env\.IMAGE \}\}:latest/)
  assert.match(imageWorkflow, /\/app\/DEPLOYED_SHA/)
  assert.match(imageWorkflow, /\/app\/WORKER_RELEASE_ID/)
  assert.match(ingestDockerfile, /ARG DEPLOYED_SHA/)
  assert.match(ingestDockerfile, /\[ "\$\{#DEPLOYED_SHA\}" -eq 40 \]/)
  assert.match(ingestDockerfile, /chmod 0444 DEPLOYED_SHA WORKER_RELEASE_ID/)
  assert.match(ingestDockerfile, /chown -R pwuser:pwuser \/app\/\.arena-ingest\nUSER pwuser/)
  assert.doesNotMatch(ingestDockerfile, /chown -R pwuser:pwuser \/app(?:\s|$)/)
  assert.match(
    ingestDockerfile,
    /COPY worker\/vendor\/brace-expansion-compat \.\/worker\/vendor\/brace-expansion-compat\nRUN npm ci/
  )
  assert.match(dockerRunner, /disabled: use the exact-main transactional SG deploy workflow/)
  assert.match(dockerCompose, /services: \{\}/)
  assert.doesNotMatch(dockerCompose, /^\s+image:/m)
  assert.match(deployGate, /ARENA_WORKER_RELEASE_ID="\$WORKER_RELEASE_ID"/)
  assert.match(deployGate, /node "\$RUNNER_TEMP\/worker-release-id\.mjs" "\$HEAD_SHA"/)
  assert.doesNotMatch(deployGate, /expected_(?:sha|release_id)=/)
  assert.match(deployGate, /steps\.worker_fleet\.outcome == 'success'/)
})

test('worker image publication has no arbitrary-ref manual trigger', () => {
  const trigger = imageWorkflow.slice(
    imageWorkflow.indexOf('on:'),
    imageWorkflow.indexOf('concurrency:')
  )

  assert.doesNotMatch(trigger, /workflow_dispatch/)
  assert.doesNotMatch(imageWorkflow, /github\.event_name == 'workflow_dispatch'/)
  assert.doesNotMatch(imageWorkflow, /manual worker image source/)
})

test('pushes nothing to the registry until the locally built image passes smoke', () => {
  const buildStart = imageWorkflow.indexOf('- name: Build image locally')
  const smokeStart = imageWorkflow.indexOf(
    '- name: Smoke image — baked stamps + actual module loads'
  )
  const loginStart = imageWorkflow.indexOf('- name: Log in to ghcr.io')
  const pushStart = imageWorkflow.indexOf('- name: Push smoked image')

  assert.ok(buildStart > 0, 'missing local build')
  assert.ok(smokeStart > buildStart, 'smoke must follow the local build')
  assert.ok(loginStart > smokeStart, 'registry login must follow successful smoke')
  assert.ok(pushStart > loginStart, 'push must follow registry login')

  const beforeLogin = imageWorkflow.slice(0, loginStart)
  assert.doesNotMatch(beforeLogin, /docker push|push: true|secrets\./)

  const build = imageWorkflow.slice(buildStart, smokeStart)
  assert.match(build, /load: true/)
  assert.match(build, /push: false/)
  assert.match(build, /DEPLOYED_SHA=\$\{\{ github\.sha \}\}/)
  assert.match(build, /WORKER_RELEASE_ID=\$\{\{ steps\.meta\.outputs\.release_id \}\}/)

  const smoke = imageWorkflow.slice(smokeStart, loginStart)
  assert.match(smoke, /docker run --rm --entrypoint cat/)
  assert.match(smoke, /\[ "\$baked_sha" = "\$DEPLOYED_SHA" \]/)
  assert.match(smoke, /\[ "\$baked_release" = "\$WORKER_RELEASE_ID" \]/)
  assert.match(smoke, /await import\(m\)/)
  assert.match(smoke, /await import\('\.\/worker\/src\/ingest\/heartbeat\.ts'\)/)
  assert.doesNotMatch(smoke, /require\.resolve/)
  assert.doesNotMatch(smoke, /\|\| true/)

  const push = imageWorkflow.slice(pushStart)
  assert.match(push, /docker push "\$IMAGE:\$GITHUB_SHA"/)
  assert.match(push, /docker push "\$IMAGE:\$WORKER_RELEASE_ID"/)
  assert.doesNotMatch(push, /:latest/)
})
