#!/usr/bin/env node
// A bug fix without a test is how the same bug comes back. Applies to pull
// requests titled fix(...) or fix: that change application code. The escape
// hatch keeps the reason on the record: `No regression test: <reason>` in the body.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SOURCE = /^(app|lib|worker\/src)\/.*\.(ts|tsx)$/
const TEST = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\/|(^|\/)e2e\//

export function evaluate({ title, body, files }) {
  if (!/^fix(\(.+\))?!?:/i.test(title)) return { ok: true, reason: 'not a fix' }
  if (!files.some((file) => SOURCE.test(file) && !TEST.test(file))) {
    return { ok: true, reason: 'no application code changed' }
  }
  if (files.some((file) => TEST.test(file))) return { ok: true, reason: 'test included' }
  if (/^No regression test:\s*\S+/im.test(body ?? '')) {
    return { ok: true, reason: 'exemption stated in the pull request' }
  }
  return {
    ok: false,
    reason: 'Add a test that fails without this fix, or state "No regression test: <reason>".',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--event') + 1], 'utf8'))
  const { title, body, base, head } = event.pull_request
  const files = execFileSync('git', ['diff', '--name-only', `${base.sha}...${head.sha}`], {
    encoding: 'utf8',
    timeout: 30_000,
  })
    .split('\n')
    .filter(Boolean)
  const result = evaluate({ title, body, files })
  console.log(result.reason)
  if (!result.ok) process.exit(1)
}
