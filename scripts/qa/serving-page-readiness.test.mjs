import assert from 'node:assert/strict'
import test from 'node:test'
import { servingPageReadiness } from './serving-page-readiness.mjs'

test('uses the visible ranking flow instead of background network silence for home', () => {
  assert.deepEqual(servingPageReadiness('home'), {
    waitUntil: 'domcontentloaded',
    readySelector: 'main#main-content a[href^="/trader/"]:visible',
    readyTimeoutMs: 10_000,
    observeMs: 5_000,
  })
})

test('preserves the existing full-network profile contract', () => {
  assert.deepEqual(servingPageReadiness('active:gmx'), {
    waitUntil: 'networkidle',
    readySelector: null,
    readyTimeoutMs: 0,
    observeMs: 3_000,
  })
})
