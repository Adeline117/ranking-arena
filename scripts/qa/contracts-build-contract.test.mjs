import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const root = new URL('../../', import.meta.url)
const FORGE_STD_COMMIT = '1801b0541f4fda118a10798fd3486bb7051c5dd6'
const CHECKOUT_ACTION_COMMIT = '11d5960a326750d5838078e36cf38b85af677262'
const SETUP_NODE_ACTION_COMMIT = '249970729cb0ef3589644e2896645e5dc5ba9c38'
const FOUNDRY_ACTION_COMMIT = '908c540300062bd5a7e473851cdb4282204cee09'

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('the Foundry unit has pinned dependencies and an isolated build workflow', async () => {
  const [packageJson, gitmodules, workflow, prettierIgnore, vercelIgnore, dockerIgnore, tracked] =
    await Promise.all([
      source('package.json').then(JSON.parse),
      source('.gitmodules'),
      source('.github/workflows/contracts.yml'),
      source('.prettierignore'),
      source('.vercelignore'),
      source('.dockerignore'),
      execFileAsync('git', ['ls-files', '--stage', 'lib/forge-std'], {
        cwd: new URL('.', root),
        encoding: 'utf8',
      }).then(({ stdout }) => stdout.trim()),
    ])

  assert.equal(packageJson.devDependencies?.['@openzeppelin/contracts'], '5.4.0')
  assert.equal(packageJson.scripts?.['contracts:build'], 'forge build --sizes')
  assert.match(gitmodules, /path = lib\/forge-std/)
  assert.match(tracked, new RegExp(`^160000 ${FORGE_STD_COMMIT} 0\\tlib/forge-std$`))
  assert.match(workflow, /submodules:\s*recursive/)
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_ACTION_COMMIT}`))
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_ACTION_COMMIT}`))
  assert.match(workflow, new RegExp(`foundry-rs/foundry-toolchain@${FOUNDRY_ACTION_COMMIT}`))
  assert.match(workflow, /version:\s*v1\.5\.1/)
  assert.match(workflow, /npm run contracts:build/)
  assert.match(prettierIgnore, /^lib\/forge-std\/$/m)
  for (const ignored of [vercelIgnore, dockerIgnore]) {
    assert.match(ignored, /^contracts\/?$/m)
    assert.match(ignored, /^script\/?$/m)
    assert.match(ignored, /^lib\/forge-std\/?$/m)
    assert.match(ignored, /^foundry\.toml$/m)
  }
})

test('the non-deploying TypeScript placeholder cannot return', async () => {
  await assert.rejects(access(new URL('contracts/scripts/deploy.ts', root)))
})
