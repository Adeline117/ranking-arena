#!/usr/bin/env node
/**
 * Blocks on high/critical advisories in production dependencies, except
 * advisories listed in EXEMPT until their expiry date.
 *
 * Why: `npm audit` has no way to skip one advisory. On 2026-11-17
 * GHSA-fc5q-39xc-vjpf (picomatch ReDoS, range <=4.0.7) was published with no
 * fixed release (4.0.7 is the latest), so the plain gate blocked every PR with
 * nothing to upgrade to. An exemption names one advisory, says why it is not
 * reachable, and expires: after that date the gate blocks on it again.
 * Owner-approved 2026-11-17.
 *
 * Usage: npm audit --omit=dev --json | node scripts/qa/npm-audit-gate.mjs
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const EXEMPT = [
  {
    ghsa: 'GHSA-fc5q-39xc-vjpf',
    expires: '2026-12-17',
    reason:
      'picomatch <=4.0.7, no fixed release. Reached only through build tooling ' +
      '(rollup/sentry bundler plugins) and unstorage file watching; every glob ' +
      'pattern is ours, none comes from a request.',
  },
]

const BLOCKING = new Set(['high', 'critical'])

/** Advisory ids (GHSA) behind a package, following `via` package names. */
function rootAdvisories(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const out = []
  for (const via of vulnerabilities[name]?.via ?? []) {
    if (typeof via === 'string') out.push(...rootAdvisories(via, vulnerabilities, seen))
    else if (BLOCKING.has(via.severity))
      out.push(
        String(via.url ?? '')
          .split('/')
          .pop()
      )
  }
  return out
}

/** Packages that must block: high/critical with at least one non-exempt advisory. */
export function blockingPackages(report, today, exempt = EXEMPT) {
  const live = new Set(exempt.filter((e) => today <= e.expires).map((e) => e.ghsa))
  const vulnerabilities = report.vulnerabilities ?? {}
  const blocked = []
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!BLOCKING.has(entry.severity)) continue
    const advisories = [...new Set(rootAdvisories(name, vulnerabilities))]
    const open = advisories.filter((id) => !live.has(id))
    // No resolvable advisory means we cannot prove it is exempt: block.
    if (advisories.length === 0 || open.length > 0) blocked.push({ name, advisories: open })
  }
  return blocked
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(0, 'utf8'))
  if (!report.vulnerabilities) {
    console.error('npm audit produced no report:', JSON.stringify(report.error ?? report))
    process.exit(1)
  }
  const blocked = blockingPackages(report, new Date().toISOString().slice(0, 10))
  for (const { name, advisories } of blocked) {
    console.error(`high/critical: ${name} ${advisories.join(' ')}`)
  }
  process.exit(blocked.length > 0 ? 1 : 0)
}
