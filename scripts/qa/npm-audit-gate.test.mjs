import assert from 'node:assert/strict'
import test from 'node:test'
import { blockingPackages } from './npm-audit-gate.mjs'

const advisory = (ghsa, severity = 'high') => ({
  severity,
  url: `https://github.com/advisories/${ghsa}`,
})
const exempt = [{ ghsa: 'GHSA-aaaa-aaaa-aaaa', expires: '2026-12-17', reason: 'test' }]
const report = {
  vulnerabilities: {
    leaf: { severity: 'high', via: [advisory('GHSA-aaaa-aaaa-aaaa')] },
    parent: { severity: 'high', via: ['leaf'] },
    minor: { severity: 'moderate', via: [advisory('GHSA-cccc-cccc-cccc', 'moderate')] },
  },
}

test('an exempt advisory and its dependents pass until the expiry date', () => {
  assert.deepEqual(blockingPackages(report, '2026-12-17', exempt), [])
})

test('the exemption stops applying the day after it expires', () => {
  const names = blockingPackages(report, '2026-12-18', exempt).map((b) => b.name)
  assert.deepEqual(names, ['leaf', 'parent'])
})

test('a second, non-exempt advisory on the same package still blocks', () => {
  const mixed = {
    vulnerabilities: {
      leaf: {
        severity: 'high',
        via: [advisory('GHSA-aaaa-aaaa-aaaa'), advisory('GHSA-bbbb-bbbb-bbbb')],
      },
    },
  }
  assert.deepEqual(blockingPackages(mixed, '2026-11-17', exempt), [
    { name: 'leaf', advisories: ['GHSA-bbbb-bbbb-bbbb'] },
  ])
})

test('a high entry whose advisory cannot be resolved blocks', () => {
  const orphan = { vulnerabilities: { ghost: { severity: 'critical', via: ['missing'] } } }
  assert.equal(blockingPackages(orphan, '2026-11-17', exempt).length, 1)
})
