import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const workflow = readFileSync('.github/workflows/build-ingest-image.yml', 'utf8')
const image = 'ghcr.io/example/ranking-arena/ingest-worker'
const releaseId = 'a'.repeat(64)
const auditSha = 'b'.repeat(40)
const digest = `sha256:${'c'.repeat(64)}`
const conflictingDigest = `sha256:${'d'.repeat(64)}`

function extractPromotionScript() {
  const marker = '      - name: Promote verified digest to release and SHA aliases'
  const stepStart = workflow.indexOf(marker)
  assert.ok(stepStart >= 0, 'promotion step is missing')

  const runMarker = '        run: |\n'
  const runStart = workflow.indexOf(runMarker, stepStart)
  assert.ok(runStart >= 0, 'promotion script is missing')

  const blockStart = runStart + runMarker.length
  const blockEnd = workflow.indexOf('\n      - name:', blockStart)
  assert.ok(blockEnd > blockStart, 'promotion script boundary is missing')

  return workflow
    .slice(blockStart, blockEnd)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n')
    .replaceAll('${{ steps.quarantine.outputs.ref }}', `${image}:quarantine-test-run`)
}

const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"

if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  ref="$4"
  found=""
  while IFS='|' read -r known_ref known_digest; do
    if [[ "$known_ref" == "$ref" ]]; then
      found="$known_digest"
    fi
  done < "$REGISTRY_STATE"
  if [[ -z "$found" ]]; then
    echo "ERROR: manifest unknown" >&2
    exit 1
  fi
  printf 'Name: %s\\nMediaType: application/vnd.oci.image.index.v1+json\\nDigest: %s\\n' "$ref" "$found"
  exit 0
fi

if [[ "$1 $2 $3" == "buildx imagetools create" ]]; then
  shift 3
  declare -a tags=()
  source_ref=""
  while (( $# > 0 )); do
    if [[ "$1" == "--tag" ]]; then
      tags+=("$2")
      shift 2
    else
      source_ref="$1"
      shift
    fi
  done
  source_digest="\${source_ref##*@}"
  for ref in "\${tags[@]}"; do
    printf '%s|%s\\n' "$ref" "$source_digest" >> "$REGISTRY_STATE"
  done
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 64
`

function runPromotion(initialTags = []) {
  const root = mkdtempSync(join(tmpdir(), 'worker-image-promotion-'))
  const bin = join(root, 'bin')
  const state = join(root, 'registry-state')
  const log = join(root, 'docker.log')
  const output = join(root, 'github-output')
  const summary = join(root, 'github-summary')

  try {
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), fakeDocker)
    chmodSync(join(bin, 'docker'), 0o755)
    writeFileSync(state, initialTags.map(([ref, refDigest]) => `${ref}|${refDigest}\n`).join(''))
    writeFileSync(log, '')
    writeFileSync(output, '')
    writeFileSync(summary, '')

    const result = spawnSync('bash', ['-c', extractPromotionScript()], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        IMAGE: image,
        DIGEST: digest,
        WORKER_RELEASE_ID: releaseId,
        AUDIT_SHA: auditSha,
        DOCKER_LOG: log,
        REGISTRY_STATE: state,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    })

    return {
      result,
      dockerLog: readFileSync(log, 'utf8'),
      output: readFileSync(output, 'utf8'),
      releaseRecord: (() => {
        try {
          return JSON.parse(readFileSync(join(root, 'worker-image-release.json'), 'utf8'))
        } catch {
          return undefined
        }
      })(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a conflicting release alias fails before any formal alias is written', () => {
  const releaseRef = `${image}:${releaseId}`
  const { result, dockerLog, output, releaseRecord } = runPromotion([
    [releaseRef, conflictingDigest],
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /refusing to overwrite/)
  assert.doesNotMatch(dockerLog, /imagetools create/)
  assert.equal(output, '')
  assert.equal(releaseRecord, undefined)
})

test('missing formal aliases are created from and verified against the smoked digest', () => {
  const { result, dockerLog, output, releaseRecord } = runPromotion()

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(
    dockerLog,
    new RegExp(
      `imagetools create --tag ${image}:${releaseId} --tag ${image}:${auditSha} ${image}@${digest}`
    )
  )
  assert.match(output, new RegExp(`^digest=${digest}$`, 'm'))
  assert.match(output, new RegExp(`^digest_ref=${image}@${digest}$`, 'm'))
  assert.deepEqual(releaseRecord, {
    schema_version: 1,
    image,
    digest,
    digest_ref: `${image}@${digest}`,
    worker_release_id: releaseId,
    audit_sha: auditSha,
    quarantine_ref: `${image}:quarantine-test-run`,
  })
})
