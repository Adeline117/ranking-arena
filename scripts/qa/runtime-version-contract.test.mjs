import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('local, package, CI, and worker runtimes stay on supported Node LTS majors', async () => {
  const [
    packageJson,
    lockJson,
    nvmrc,
    mobileWorkflow,
    workerDockerfile,
    readme,
    onboarding,
    localSetup,
  ] = await Promise.all([
    source('package.json').then(JSON.parse),
    source('package-lock.json').then(JSON.parse),
    source('.nvmrc'),
    source('.github/workflows/mobile-build.yml'),
    source('worker/Dockerfile.ingest'),
    source('README.md'),
    source('docs/ONBOARDING.md'),
    source('docs/LOCAL_SETUP.md'),
  ])

  assert.equal(packageJson.engines?.node, '>=22.19 <25')
  assert.equal(lockJson.packages?.['']?.engines?.node, '>=22.19 <25')
  assert.equal(nvmrc.trim(), '22')
  assert.match(mobileWorkflow, /NODE_VERSION:\s*['"]22['"]/)
  assert.doesNotMatch(mobileWorkflow, /NODE_VERSION:\s*['"]20['"]/)
  assert.match(workerDockerfile, /^FROM node:22-bookworm-slim AS deps$/m)
  assert.doesNotMatch(workerDockerfile, /^FROM node:20-/m)
  assert.match(readme, /Node\.js 22\.19-24\.x/)
  assert.match(onboarding, /Node\.js 22\.19\+ and <25/)
  assert.match(localSetup, /\*\*Node 22\*\*/)
  assert.doesNotMatch(`${readme}\n${onboarding}\n${localSetup}`, /Node(?:\.js)? 20/)
})
