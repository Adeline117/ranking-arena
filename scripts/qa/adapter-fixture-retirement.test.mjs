import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const fixtures = 'lib/ingest/adapters/bitmart/__tests__/fixtures'
const retiredFixtureName = ['chart', '3m.json'].join('-')
const retiredFixture = `${fixtures}/${retiredFixtureName}`
const canonicalFixture = `${fixtures}/chart-1m.json`

function trackedEntry(path) {
  const result = spawnSync('git', ['ls-files', '--stage', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('keeps the duplicate BitMart 3M chart fixture fully retired', async () => {
  await assert.rejects(lstat(new URL(retiredFixture, root)), (error) => error?.code === 'ENOENT')
  assert.equal(trackedEntry(retiredFixture), '')

  const references = spawnSync(
    'git',
    ['grep', '--line-number', '--fixed-strings', retiredFixtureName, '--', '.'],
    { cwd: root, encoding: 'utf8' }
  )

  assert.equal(references.status, 1, references.stderr || references.stdout)
  assert.equal(references.stdout, '')
})

test('keeps the canonical BitMart chart fixture regular, tracked, and explicitly consumed', async () => {
  const canonicalStat = await lstat(new URL(canonicalFixture, root))
  assert.equal(canonicalStat.isSymbolicLink(), false)
  assert.equal(canonicalStat.isFile(), true)
  assert.match(trackedEntry(canonicalFixture), /^100644 [0-9a-f]{40} 0\t/)

  const [parserTest, parityTest] = await Promise.all([
    readFile(new URL('lib/ingest/adapters/bitmart/__tests__/parsers.test.ts', root), 'utf8'),
    readFile(
      new URL('lib/ingest/adapters/__tests__/expected-metrics-parity.test.ts', root),
      'utf8'
    ),
  ])
  const parserReference = /\bchart:\s*fixture\(\s*(['"])chart-1m\.json\1\s*\)/g
  const parityReference =
    /\bchart:\s*fixture\(\s*(['"])bitmart\1\s*,\s*(['"])chart-1m\.json\2\s*\)/g

  assert.equal([...parserTest.matchAll(parserReference)].length, 1)
  assert.equal([...parityTest.matchAll(parityReference)].length, 1)
})
