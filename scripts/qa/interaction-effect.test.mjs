import assert from 'node:assert/strict'
import test from 'node:test'
import { clickEffectStatus, hasObservableEffect } from './interaction-effect.mjs'

const base = {
  url: 'https://www.arenafi.org/',
  textLen: 100,
  textHash: 1,
  stateHash: 2,
  overlays: 0,
  nodes: 50,
}

test('detects DOM attribute state changes even when text and node count stay fixed', () => {
  assert.equal(hasObservableEffect(base, { ...base, stateHash: 3 }, 0), true)
})

test('detects URL, content, overlay, node, and network effects', () => {
  assert.equal(hasObservableEffect(base, { ...base, url: `${base.url}rankings` }, 0), true)
  assert.equal(hasObservableEffect(base, { ...base, textHash: 9 }, 0), true)
  assert.equal(hasObservableEffect(base, { ...base, overlays: 1 }, 0), true)
  assert.equal(hasObservableEffect(base, { ...base, nodes: 53 }, 0), true)
  assert.equal(hasObservableEffect(base, base, 1), true)
})

test('keeps a truly unchanged standalone control as a dead interaction', () => {
  assert.equal(clickEffectStatus({ before: base, after: base, requestDelta: 0 }), 'dead:no-effect')
})

test('accepts an idempotent click only for an already-active grouped choice', () => {
  assert.equal(
    clickEffectStatus({ before: base, after: base, requestDelta: 0, activeChoice: true }),
    'ok:active-choice'
  )
  assert.equal(
    clickEffectStatus({ before: base, after: base, requestDelta: 0, activeChoice: false }),
    'dead:no-effect'
  )
})
