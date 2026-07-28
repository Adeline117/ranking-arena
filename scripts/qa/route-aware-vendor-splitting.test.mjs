import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nextConfig = fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8')

test('keeps Next.js route-aware client chunking in control', () => {
  assert.doesNotMatch(nextConfig, /\bsplitChunks\b/)
  assert.doesNotMatch(nextConfig, /name:\s*['"]vendor['"]/)
})
