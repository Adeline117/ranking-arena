import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const imageWorkflow = readFileSync('.github/workflows/build-ingest-image.yml', 'utf8')
const deployGate = readFileSync('.github/workflows/deploy-gate.yml', 'utf8')
const ingestDockerfile = readFileSync('worker/Dockerfile.ingest', 'utf8')
const dockerRunner = readFileSync('worker/docker-run-sg.sh', 'utf8')
const dockerCompose = readFileSync('worker/docker-compose.sg.yml', 'utf8')

const PINNED_IMAGE_ACTIONS = [
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
  'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
  'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
]

test('builds a deployable worker image whenever deterministic runtime inputs change', () => {
  const pushTrigger = imageWorkflow.slice(
    imageWorkflow.indexOf('on:'),
    imageWorkflow.indexOf('concurrency:')
  )

  assert.match(pushTrigger, /push:\n    branches: \[main\]/)
  for (const path of [
    "'worker/**'",
    "'lib/**'",
    "'.dockerignore'",
    "'scripts/ci/worker-release-id.mjs'",
    "'.github/workflows/build-ingest-image.yml'",
    "'.github/workflows/deploy-ingest-sg.yml'",
  ]) {
    assert.ok(pushTrigger.includes(path), `missing worker image trigger for ${path}`)
  }
  for (const rootAppInput of [
    "'package.json'",
    "'package-lock.json'",
    "'.npmrc'",
    "'tsconfig.json'",
  ]) {
    assert.ok(
      !pushTrigger.includes(rootAppInput),
      `root app input must not invalidate the Worker image: ${rootAppInput}`
    )
  }
  for (const foundryPath of ["'!lib/forge-std'", "'!lib/forge-std/**'"]) {
    assert.ok(
      pushTrigger.includes(foundryPath),
      `Foundry-only input must not trigger the Worker image: ${foundryPath}`
    )
    assert.ok(
      pushTrigger.indexOf(foundryPath) > pushTrigger.indexOf("'lib/**'"),
      `Foundry exclusion must follow the positive shared-lib pattern: ${foundryPath}`
    )
  }
  assert.match(imageWorkflow, /node scripts\/ci\/worker-release-id\.mjs "\$GITHUB_SHA"/)
  assert.match(
    imageWorkflow,
    /tag="quarantine-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{GITHUB_SHA\}"/
  )
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
    /COPY worker\/package\.json worker\/package-lock\.json worker\/\.npmrc \.\/\nRUN npm ci --omit=dev/
  )
  assert.match(ingestDockerfile, /TSX_TSCONFIG_PATH=\/app\/worker\/tsconfig\.json/)
  assert.doesNotMatch(ingestDockerfile, /COPY package\.json package-lock\.json/)
  assert.match(dockerRunner, /disabled: use the exact-main transactional SG deploy workflow/)
  assert.match(dockerCompose, /services: \{\}/)
  assert.doesNotMatch(dockerCompose, /^\s+image:/m)
  assert.match(deployGate, /ARENA_WORKER_RELEASE_ID="\$WORKER_RELEASE_ID"/)
  assert.match(deployGate, /node "\$RUNNER_TEMP\/worker-release-id\.mjs" "\$HEAD_SHA"/)
  assert.doesNotMatch(deployGate, /expected_(?:sha|release_id)=/)
  assert.match(deployGate, /steps\.worker_fleet\.outcome == 'success'/)
})

test('production image build actions are pinned to immutable commits', () => {
  for (const action of PINNED_IMAGE_ACTIONS) {
    assert.match(imageWorkflow, new RegExp(`uses: ${action}`))
  }
  for (const match of imageWorkflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
    assert.match(match[1], /^[^@]+@[a-f0-9]{40}$/u, `mutable image-build action: ${match[1]}`)
  }
})

test('manual image builds remain exact origin/main through alias promotion', () => {
  const deriveStart = imageWorkflow.indexOf('- name: Derive deterministic worker release ID')
  const smokeStart = imageWorkflow.indexOf(
    '- name: Smoke quarantine digest — stamp + actual module loads'
  )
  const recheckStart = imageWorkflow.indexOf(
    '- name: Recheck manual dispatch exact main before promotion'
  )
  const promoteStart = imageWorkflow.indexOf(
    '- name: Promote verified digest to release and SHA aliases'
  )

  const manualConditions = imageWorkflow.match(/if: github\.event_name == 'workflow_dispatch'/g)
  assert.equal(manualConditions?.length, 2)
  assert.ok(
    imageWorkflow.indexOf('- name: Require manual dispatch to target exact origin/main') <
      deriveStart,
    'manual exact-main gate must precede release derivation'
  )
  assert.ok(recheckStart > smokeStart, 'manual exact-main recheck must follow digest smoke')
  assert.ok(recheckStart < promoteStart, 'manual exact-main recheck must precede alias promotion')
  assert.equal(imageWorkflow.match(/refs\/heads\/main:refs\/remotes\/origin\/main/g)?.length, 2)
  assert.equal(imageWorkflow.match(/\[ "\$GITHUB_SHA" != "\$main_sha" \]/g)?.length, 2)
  assert.match(imageWorkflow, /manual worker image source is not exact origin\/main/)
  assert.match(imageWorkflow, /manual worker image source stopped being exact origin\/main/)
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
  assert.match(preSmokeBuild, /DEPLOYED_SHA=\$\{\{ github\.sha \}\}/)
  assert.match(preSmokeBuild, /WORKER_RELEASE_ID=\$\{\{ steps\.worker_release\.outputs\.id \}\}/)
  assert.doesNotMatch(preSmokeBuild, /^\s*tags:.*worker_release/m)
  assert.doesNotMatch(preSmokeBuild, /^\s*tags:.*github\.sha/m)

  const smoke = imageWorkflow.slice(smokeStart, promoteStart)
  assert.match(smoke, /digest_ref="\$\{IMAGE\}@\$\{DIGEST\}"/)
  assert.match(smoke, /docker run --rm --entrypoint cat/)
  assert.match(smoke, /\/app\/DEPLOYED_SHA/)
  assert.match(smoke, /\[ "\$baked_sha" = "\$DEPLOYED_SHA" \]/)
  assert.match(smoke, /\/app\/WORKER_RELEASE_ID/)
  assert.match(smoke, /\[ "\$baked_release" = "\$WORKER_RELEASE_ID" \]/)
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
  assert.match(imageWorkflow, new RegExp(`uses: ${PINNED_IMAGE_ACTIONS.at(-1)}`))
})
