import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SEED_SCRIPT = join(ROOT, 'scripts/maintenance/seed-supabase-typegen-image.sh')
const POSTGRES_META_DIGEST =
  'sha256:a84cc713585eea7b401e4a2561ec4a1e48c87083d1c7ecb4502f204bb4391300'
const MIRROR_IMAGE = `supabase/postgres-meta@${POSTGRES_META_DIGEST}`
const ECR_IMAGE = `public.ecr.aws/supabase/postgres-meta@${POSTGRES_META_DIGEST}`
const CLI_IMAGE = 'public.ecr.aws/supabase/postgres-meta:v0.96.6'

const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n')

function pullResult(kind) {
  const counterPath = join(process.env.FAKE_DOCKER_STATE_DIR, kind + '-pull-count')
  let count = 0
  try {
    count = Number(readFileSync(counterPath, 'utf8'))
  } catch {}
  count += 1
  writeFileSync(counterPath, String(count))

  const configured = process.env['FAKE_' + kind.toUpperCase() + '_FAILURES'] || '0'
  const failures = configured === 'always' ? Number.POSITIVE_INFINITY : Number(configured)
  process.exit(count <= failures ? 1 : 0)
}

if (args[0] === 'pull') {
  if (args[1].startsWith('supabase/postgres-meta@')) pullResult('mirror')
  if (args[1].startsWith('public.ecr.aws/supabase/postgres-meta@')) pullResult('ecr')
  process.exit(2)
}

if (args[0] === 'tag') process.exit(0)

if (args[0] === 'image' && args[1] === 'inspect') {
  const id =
    args[2] === '${CLI_IMAGE}'
      ? process.env.FAKE_CLI_IMAGE_ID
      : process.env.FAKE_SOURCE_IMAGE_ID
  process.stdout.write(id + '\\n')
  process.exit(0)
}

process.exit(2)
`

const FAKE_SLEEP = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.FAKE_SLEEP_LOG, process.argv.slice(2).join(' ') + '\\n')
`

function readLines(file) {
  const body = readFileSync(file, 'utf8').trim()
  return body ? body.split('\n') : []
}

function runSeed({
  mirrorFailures = '0',
  ecrFailures = '0',
  sourceImageId = 'sha256:seeded-image',
  cliImageId = sourceImageId,
} = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'arena-typegen-seed-'))
  const bin = join(temp, 'bin')
  const state = join(temp, 'state')
  const dockerLog = join(temp, 'docker.log')
  const sleepLog = join(temp, 'sleep.log')
  mkdirSync(bin)
  mkdirSync(state)
  writeFileSync(dockerLog, '')
  writeFileSync(sleepLog, '')

  const dockerPath = join(bin, 'docker')
  const sleepPath = join(bin, 'sleep')
  writeFileSync(dockerPath, FAKE_DOCKER)
  writeFileSync(sleepPath, FAKE_SLEEP)
  chmodSync(dockerPath, 0o755)
  chmodSync(sleepPath, 0o755)

  try {
    const result = spawnSync('bash', [SEED_SCRIPT], {
      cwd: ROOT,
      env: {
        ...process.env,
        FAKE_CLI_IMAGE_ID: cliImageId,
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_DOCKER_STATE_DIR: state,
        FAKE_ECR_FAILURES: ecrFailures,
        FAKE_MIRROR_FAILURES: mirrorFailures,
        FAKE_SLEEP_LOG: sleepLog,
        FAKE_SOURCE_IMAGE_ID: sourceImageId,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
      encoding: 'utf8',
    })

    return {
      ...result,
      dockerCalls: readLines(dockerLog).map((line) => JSON.parse(line)),
      sleeps: readLines(sleepLog),
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

test('seeds the CLI tag from the pinned Docker Hub mirror on first success', () => {
  const result = runSeed()

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.sleeps, [])
  assert.deepEqual(result.dockerCalls, [
    ['pull', MIRROR_IMAGE],
    ['tag', MIRROR_IMAGE, CLI_IMAGE],
    ['image', 'inspect', MIRROR_IMAGE, '--format', '{{.Id}}'],
    ['image', 'inspect', CLI_IMAGE, '--format', '{{.Id}}'],
  ])
  assert.match(result.stdout, new RegExp(`Seeded ${CLI_IMAGE}`))
})

test('falls back to the pinned ECR digest after three Docker Hub failures', () => {
  const result = runSeed({ mirrorFailures: 'always' })
  const pulls = result.dockerCalls.filter(([command]) => command === 'pull')

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(pulls, [
    ['pull', MIRROR_IMAGE],
    ['pull', MIRROR_IMAGE],
    ['pull', MIRROR_IMAGE],
    ['pull', ECR_IMAGE],
  ])
  assert.deepEqual(result.sleeps, ['10', '20'])
  assert.ok(
    result.dockerCalls.some(
      (args) => args[0] === 'tag' && args[1] === ECR_IMAGE && args[2] === CLI_IMAGE
    )
  )
  assert.match(
    result.stderr,
    /Docker Hub mirror unavailable; falling back to the CLI's Public ECR source/
  )
})

test('returns non-zero after both pinned registries exhaust their retries', () => {
  const result = runSeed({ mirrorFailures: 'always', ecrFailures: 'always' })
  const pulls = result.dockerCalls.filter(([command]) => command === 'pull')

  assert.notEqual(result.status, 0)
  assert.deepEqual(pulls, [
    ['pull', MIRROR_IMAGE],
    ['pull', MIRROR_IMAGE],
    ['pull', MIRROR_IMAGE],
    ['pull', ECR_IMAGE],
    ['pull', ECR_IMAGE],
    ['pull', ECR_IMAGE],
  ])
  assert.deepEqual(result.sleeps, ['10', '20', '10', '20'])
  assert.equal(
    result.dockerCalls.some(([command]) => command === 'tag'),
    false
  )
})

test('returns non-zero when the seeded CLI tag has a different image ID', () => {
  const result = runSeed({ cliImageId: 'sha256:unexpected-image' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /seeded postgres-meta image does not match the pinned mirror/)
  assert.deepEqual(result.sleeps, [])
  assert.deepEqual(result.dockerCalls.slice(-2), [
    ['image', 'inspect', MIRROR_IMAGE, '--format', '{{.Id}}'],
    ['image', 'inspect', CLI_IMAGE, '--format', '{{.Id}}'],
  ])
})
