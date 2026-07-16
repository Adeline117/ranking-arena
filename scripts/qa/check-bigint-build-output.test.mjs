import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findUnsafeBigIntPower } from './check-bigint-build-output.mjs'

function fixture(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bigint-build-'))
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
  return directory
}

test('accepts native BigInt exponentiation emitted by webpack', (t) => {
  const directory = fixture({ 'web3.js': 'const field = base ** BigInt(254)' })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(findUnsafeBigIntPower(directory), [])
})

test('rejects direct Math.pow with a BigInt exponent', (t) => {
  const directory = fixture({ 'web3.js': 'const field = Math.pow(base,BigInt(254))' })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(findUnsafeBigIntPower(directory), [path.join(directory, 'web3.js')])
})

test('rejects wrapped minifier output in nested chunks', (t) => {
  const directory = fixture({
    'app/wallet.js': 'const field=(0,Math.pow)(base, BigInt(447))',
    'app/safe.js': 'const other = Math.pow(base, 2)',
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(findUnsafeBigIntPower(directory), [path.join(directory, 'app/wallet.js')])
})

test('fails closed when no browser chunks exist', (t) => {
  const directory = fixture({ 'readme.txt': 'not a browser chunk' })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => findUnsafeBigIntPower(directory), /no browser JavaScript chunks/)
})
