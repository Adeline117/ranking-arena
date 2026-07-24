import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = readFileSync('.github/workflows/deploy-ingest-sg.yml', 'utf8')
const parsedWorkflow = parse(workflow)

test('SG dispatch is bound to one exact current-main commit throughout deployment', () => {
  assert.match(workflow, /target_sha:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/)
  assert.equal((workflow.match(/ref: \$\{\{ inputs\.target_sha \}\}/g) ?? []).length, 2)
  assert.equal(
    (
      workflow.match(
        /git fetch --force --no-tags origin refs\/heads\/main:refs\/remotes\/origin\/main/g
      ) ?? []
    ).length,
    4
  )
  assert.ok(
    (workflow.match(/\^\[0-9a-f\]\{40\}\$/g) ?? []).length >= 2,
    'both jobs must reject a non-full target SHA'
  )
  assert.match(workflow, /origin\/main advanced before deployment; refusing stale cutover/)
  assert.match(workflow, /origin\/main advanced after transactional success/)
})

test('production secrets are gated by a main-only deployment environment contract', () => {
  const deployJob = parsedWorkflow.jobs['deploy-sg']
  assert.equal(deployJob.environment, 'ingest-sg-production')
  assert.equal(parsedWorkflow.on.workflow_dispatch.inputs.target_sha.required, true)
  assert.match(workflow, /\[ "\$GITHUB_REF" = 'refs\/heads\/main' \]/)
  assert.match(workflow, /\[ "\$GITHUB_SHA" = "\$TARGET_SHA" \]/)
})

test('third-party actions are pinned to immutable full commit SHAs', () => {
  const uses = [...workflow.matchAll(/uses: ([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.ok(uses.length > 0)
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/)
  }
})

test('code-only accepts only an intentionally skipped dependency build', () => {
  assert.match(workflow, /if: \$\{\{ inputs\.mode != 'code-only' \}\}/)
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) \}\}/)
  assert.match(workflow, /full:success\|code-only:skipped/)
  assert.match(workflow, /if \[ "\$DEPLOY_MODE" = 'code-only' \]; then/)
  assert.match(workflow, /deploy-ingest-sg\.sh --target-sha="\$TARGET_SHA" --code-only/)
})

test('dependency packaging does not download an unused local browser', () => {
  assert.doesNotMatch(workflow, /playwright install/)
  assert.match(workflow, /await import\(module\)/)
})

test('full artifact carries a strict independently recomputed manifest', () => {
  for (const key of [
    'TARGET_SHA',
    'WORKER_RELEASE_ID',
    'DEP_INPUTS_SHA256',
    'NODE_MAJOR',
    'ARCH',
    'TARBALL_SHA256',
  ]) {
    assert.ok(workflow.includes(key), `manifest is missing ${key}`)
  }
  assert.match(workflow, /node scripts\/ci\/worker-release-id\.mjs "\$TARGET_SHA"/)
  assert.match(workflow, /sha256sum \.npmrc package\.json package-lock\.json/)
  assert.match(workflow, /sha256sum arena-ingest-deps\.tgz/)
  assert.match(workflow, /arena-ingest-deps\.manifest/)
  assert.match(workflow, /artifact manifest contains missing or unknown keys/)
  assert.match(workflow, /--artifact-manifest="\$PWD\/arena-ingest-deps\.manifest"/)
  assert.match(workflow, /--target-sha="\$TARGET_SHA"/)
  assert.doesNotMatch(workflow, /(?:source|\.)\s+[^\n]*arena-ingest-deps\.manifest/)
})

test('missing SSH trust inputs fail closed and host identity is pinned', () => {
  for (const secret of ['INGEST_SG_SSH_KEY', 'INGEST_SG_HOST', 'INGEST_SG_KNOWN_HOSTS']) {
    assert.match(workflow, new RegExp(`${secret} is required`))
  }
  assert.doesNotMatch(workflow, /ssh-keyscan/)
  assert.doesNotMatch(workflow, /skip=true/)
  assert.match(workflow, /ssh-keygen -F "\$hostname" -f ~\/\.ssh\/known_hosts/)
  assert.match(workflow, /StrictHostKeyChecking yes/)
  assert.match(workflow, /UserKnownHostsFile ~\/\.ssh\/known_hosts/)
})

test('workflow claims only the SG readiness evidence executed by the deploy script', () => {
  assert.match(workflow, /Deploy and require fresh SG readiness evidence/)
  assert.doesNotMatch(workflow, /Verify both nodes converged/)
  assert.doesNotMatch(workflow, /follow-up gate that polls/)
  assert.match(workflow, /new rollout, not a\n\s+# failed old rollout/)
})
