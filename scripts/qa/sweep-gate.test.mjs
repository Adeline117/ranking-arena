import assert from 'node:assert/strict'
import test from 'node:test'
import { hardSweepFindings, hardSweepReasons } from './sweep-gate.mjs'

test('gates interaction, route, page-health, translation, and coverage failures', () => {
  for (const status of [
    'fail:click',
    'fail:fill',
    'fail:route',
    'fail:redirect:/login',
    'fail:coverage-cap',
    'dead:no-effect',
    'pagehealth:blank',
    'pagehealth:not-found',
    'i18n-leak:2',
  ]) {
    assert.deepEqual(hardSweepReasons({ status, errors: [] }), [`status:${status}`])
  }
})

test('gates browser, console, and unexpected HTTP errors', () => {
  const reasons = hardSweepReasons({
    status: 'ok:clicked',
    errors: ['pageerror: render crashed', 'console: failed fetch', 'http: 404 GET /api/example'],
  })

  assert.deepEqual(reasons, [
    'pageerror: render crashed',
    'console: failed fetch',
    'http: 404 GET /api/example',
  ])
})

test('keeps explicit skips, safe denials, links, and observed contrast advisory', () => {
  for (const status of [
    'ok:clicked',
    'ok:filled',
    'skip:hidden',
    'denied:destructive',
    'link:/rankings',
    'redirect-ok:/login',
    'a11y:contrast:3',
  ]) {
    assert.deepEqual(hardSweepReasons({ status, errors: [] }), [])
  }
})

test('returns only records with hard findings', () => {
  const ledger = [
    { route: '/', status: 'ok:clicked', errors: [] },
    { route: '/rankings', status: 'fail:click', errors: [] },
  ]

  assert.deepEqual(hardSweepFindings(ledger), [
    {
      record: ledger[1],
      reasons: ['status:fail:click'],
    },
  ])
})
