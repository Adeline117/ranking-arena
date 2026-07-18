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

test('uses visible core identity instead of optional provider idleness for profiles', () => {
  assert.deepEqual(servingPageReadiness('active:gmx'), {
    waitUntil: 'domcontentloaded',
    readySelector: 'main#main-content h1:visible',
    readyTimeoutMs: 15_000,
    observeMs: 5_000,
  })
})
