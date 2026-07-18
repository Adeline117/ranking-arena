import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const workflowsDir = join(repoRoot, '.github/workflows')

test('GitHub workflows use the lockfile or fail without dependency fallback', () => {
  const workflowFiles = readdirSync(workflowsDir)
    .filter((file) => ['.yml', '.yaml'].includes(extname(file)))
    .sort()

  const offenders = []
  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowsDir, file), 'utf8')
    if (/npm ci[^\n]*\|\|[^\n]*npm install/.test(source)) {
      offenders.push(file)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `workflow dependency fallbacks bypass package-lock.json: ${offenders.join(', ')}`
  )
})
