import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const WORKFLOW_DIR = resolve(import.meta.dirname, '..', '..', '.github', 'workflows')

// Every remote action must be pinned to a full commit SHA with its release
// recorded in a trailing comment. A mutable tag (`@v4`) lets an upstream tag
// move under a job that may hold signing or deployment secrets.
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/

test('every workflow action is pinned to a commit SHA with its release tag', () => {
  const unpinned = []
  for (const file of readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/)
      if (!match) return
      const ref = match[1]
      // Local composite actions and container images are not remote tags.
      if (ref.startsWith('./') || ref.startsWith('docker://')) return
      if (!PINNED.test(ref)) unpinned.push(`${file}:${index + 1} ${ref}`)
    })
  }
  assert.deepEqual(unpinned, [])
})
