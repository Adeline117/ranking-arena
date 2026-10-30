import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/sync-exchange-logos.sh'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const exchangeLogoSource = readFileSync(resolve(ROOT, 'app/components/ui/ExchangeLogo.tsx'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const forbiddenRuntimeTokens =
  /https?:\/\/|\b(?:curl|wget|fetch|google|favicon|file|mv|rm|cp|touch|mkdir|ln|sha(?:1|224|256|384|512)?|md5|shasum|openssl|find|grep|sed|awk|wc|tr|read|test|source|export|env|dotenv|npm|node|python|git|ssh|scp|rsync|vercel|docker|pm2)\b|\$\{?|\$\(/i

function section(source, heading, nextHeading) {
  const start = source.indexOf(heading)
  const end = source.indexOf(nextHeading, start + heading.length)

  assert.notEqual(start, -1, `missing ${heading}`)
  return source.slice(start, end === -1 ? undefined : end)
}

function runTombstone(args) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

test('exchange logo sync is an executable inert exit-2 tombstone', () => {
  assert.equal(
    source,
    "#!/bin/bash\n\n>&2 printf '%s\\n' '[RETIRED] scripts/sync-exchange-logos.sh'\nexit 2\n"
  )
  assert.doesNotMatch(source, forbiddenRuntimeTokens)
  assert.notEqual(statSync(resolve(ROOT, script)).mode & 0o111, 0, `${script} must stay executable`)

  for (const args of [[], ['--force'], ['okx', 'gmx'], ['--unexpected-legacy-flag=value']]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/sync-exchange-logos.sh\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('local logo rendering and scope documentation do not restore logo acquisition', () => {
  assert.match(exchangeLogoSource, /Checked-in static logo assets/)
  assert.match(exchangeLogoSource, /does not fetch or prescribe their origin/)
  assert.match(exchangeLogoSource, /LOCAL_LOGOS/)
  assert.doesNotMatch(
    exchangeLogoSource,
    /sync-exchange-logos\.sh|Google Favicon|all logos sourced/i
  )

  const localLogoPaths = [...exchangeLogoSource.matchAll(/'(?<path>\/icons\/exchanges\/[^']+)'/g)]
    .map((match) => match.groups?.path)
    .filter(Boolean)

  assert.notEqual(localLogoPaths.length, 0, 'LOCAL_LOGOS must retain checked-in local assets')
  for (const logoPath of localLogoPaths) {
    assert.ok(existsSync(resolve(ROOT, 'public', logoPath.slice(1))), `${logoPath} must exist`)
  }

  const progressSection = section(progress, '## V1 exchange-logo sync source containment', '\n## ')
  const runbookSection = section(runbook, '### V1 exchange-logo sync source boundary', '\n### ')

  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /`scripts\/sync-exchange-logos\.sh`/)
    assert.match(document, /source-only/i)
    assert.match(document, /public\/icons\/exchanges/)
    assert.doesNotMatch(document, /all logo acquisition.*stopped/i)
  }

  assert.match(runbookSection, /another logo acquisition or refresh workflow has stopped/i)
})
