import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const ignoreRules = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8')

function ignoredByVercelRules(relativePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-vercel-upload-'))
  try {
    spawnSync('git', ['init', '--quiet'], { cwd: directory, check: true })
    fs.writeFileSync(path.join(directory, '.gitignore'), ignoreRules)
    const target = path.join(directory, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
    const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relativePath], {
      cwd: directory,
    })
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore failed with status ${result.status}`)
    }
    return result.status === 0
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('uploads the build lifecycle checker required by package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.match(packageJson.scripts.postbuild, /qa:build-bigint/)
  assert.equal(packageJson.scripts['qa:build-bigint'], 'node check-bigint-build-output.mjs')
  assert.equal(ignoredByVercelRules('check-bigint-build-output.mjs'), false)
  assert.equal(ignoredByVercelRules('scripts/qa/check-bigint-build-output.mjs'), true)
})

test('keeps unrelated operational scripts out of the Vercel upload', () => {
  assert.equal(ignoredByVercelRules('scripts/openclaw/daily-pipeline-report.mjs'), true)
  assert.equal(ignoredByVercelRules('scripts/post-deploy-check.sh'), true)
})

test('keeps Vercel candidate failures reproducible and diagnosable', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-gate.yml'), 'utf8')
  assert.doesNotMatch(workflow, /vercel@latest/)
  assert.match(workflow, /vercel@56\.2\.1 deploy[^\n]+--logs/)
  assert.match(workflow, /vercel@56\.2\.1 deploy --dry --format=json/)
  assert.match(workflow, /Vercel upload manifest is missing required build file/)
  assert.match(workflow, /--build-env VERCEL_BUILD_SYSTEM_REPORT=1/)
  assert.match(workflow, /vercel@56\.2\.1 inspect "\$CANDIDATE_URL" --logs/)
  assert.match(workflow, /::error title=Vercel candidate build failed::/)
})
