import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const surface = JSON.parse(readFileSync(resolve(import.meta.dirname, 'v1-surface.json'), 'utf8'))

// core: the V1 product. maintained: kept working, no new features.
// hold: not on the V1 path, so it gets no investment until the owner decides.
function topLevelRoutes() {
  const pages = execFileSync('git', ['ls-files', 'app'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /(^|\/)page\.tsx$/.test(file))
  const routes = pages.map((file) => {
    const segments = file
      .split('/')
      .slice(1, -1)
      .filter((segment) => !/^\(.*\)$/.test(segment))
    return segments[0] ?? '/'
  })
  return [...new Set(routes)].sort()
}

test('every top-level page belongs to exactly one V1 tier', () => {
  const classified = Object.values(surface).flat()
  assert.equal(new Set(classified).size, classified.length, 'a route is listed in two tiers')
  assert.deepEqual([...classified].sort(), topLevelRoutes())
})
