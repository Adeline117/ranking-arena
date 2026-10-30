import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scripts = [
  'scripts/archive/check-failed-jobs.mjs',
  'scripts/archive/check-failed-tasks.mjs',
  'scripts/archive/check-latest-errors.mjs',
  'scripts/archive/check-rankings.mjs',
]
const archiveReadme = readFileSync(resolve(ROOT, 'scripts/archive/README.md'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')
const forbiddenLegacyCapabilitySyntax =
  /\b(?:import|require|env|dotenv|supabase|createClient|fetch|url|console|fs|network|read\w*|query\w*|pipeline_logs|cron_tasks|trader_snapshots|trader_scores|trader_sources)\b|node:(?:fs|path|url)|process\.(?:env|argv)|https?:\/\/|\.(?:from|select|order|limit|eq|gte|in)\s*\(|\$[({A-Za-z_]/i

function section(source, heading, nextHeading) {
  const start = source.indexOf(heading)
  const end = source.indexOf(nextHeading, start + heading.length)

  assert.notEqual(start, -1, `missing ${heading}`)
  return source.slice(start, end === -1 ? undefined : end)
}

function expectedSource(script) {
  return `#!/usr/bin/env node\n\nprocess.stderr.write('[RETIRED] ${script}\\n')\nprocess.exitCode = 2\n`
}

function runTombstone(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

test('archive service-role diagnostic CLIs retain no former runtime capability', () => {
  for (const script of scripts) {
    const source = readFileSync(resolve(ROOT, script), 'utf8')
    const runtimeSource = source.replace(/^#!\/usr\/bin\/env node\n/, '')

    assert.equal(source, expectedSource(script), `${script} must be the exact tombstone source`)
    assert.doesNotMatch(runtimeSource, forbiddenLegacyCapabilitySyntax, script)
    assert.equal(
      statSync(resolve(ROOT, script)).mode & 0o111,
      0,
      `${script} must remain non-executable`
    )
  }
})

test('archive service-role diagnostic tombstones fail closed under an empty environment', () => {
  for (const script of scripts) {
    for (const args of [[], ['--sources', '--all'], ['--url=https://ignored.invalid', '--force']]) {
      const result = runTombstone(script, args)

      assert.equal(result.error, undefined, `${script} must launch`)
      assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
      assert.equal(result.stdout, '', `${script} must keep stdout empty`)
      assert.equal(
        result.stderr,
        `[RETIRED] ${script}\n`,
        `${script} must only report its retirement on stderr`
      )
    }
  }
})

test('documentation limits the retirement to four archive diagnostics', () => {
  const progressSection = section(
    progress,
    '## V1 archive service-role diagnostic CLIs source containment',
    '\n## '
  )
  const runbookSection = section(
    runbook,
    '### V1 archive service-role diagnostic CLI source boundary',
    '\n### '
  )

  for (const script of scripts) {
    assert.match(archiveReadme, new RegExp(`\\\`${script.replaceAll('.', '\\.')}\\\``))
    for (const document of [progressSection, runbookSection]) {
      assert.match(document, new RegExp(`\\\`${script.replaceAll('.', '\\.')}\\\``))
    }
  }

  for (const document of [progressSection, runbookSection]) {
    assert.match(document, /source-only/i)
    assert.match(document, /PipelineLogger/)
    assert.match(document, /\/api\/health\/pipeline/)
    assert.match(document, /\/api\/cron\/meta-monitor/)
    assert.match(document, /leaderboard_ranks/)
    assert.match(document, /public rankings/)
    assert.match(document, /cleanup\/compute cron/)
    assert.match(document, /external state|外部状态/i)
    assert.doesNotMatch(document, /all (?:archive )?diagnostics.*stopped/i)
  }
  assert.match(archiveReadme, /covers only those four files/)

  for (const activePath of [
    'lib/services/pipeline-logger.ts',
    'app/api/health/pipeline/route.ts',
    'app/api/cron/meta-monitor/route.ts',
    'scripts/diagnose.mjs',
    'scripts/check_seasons.mjs',
    'scripts/check_enrichment.mjs',
    'app/api/rankings/route.ts',
  ]) {
    assert.ok(existsSync(resolve(ROOT, activePath)), `${activePath} must remain outside this batch`)
  }
  for (const script of scripts) {
    assert.doesNotMatch(packageJson, new RegExp(script.replaceAll('.', '\\.')))
    assert.doesNotMatch(ciWorkflow, new RegExp(script.replaceAll('.', '\\.')))
  }
  assert.match(packageJson, /"qa:sweep-unit": "node --test scripts\/qa\/\*\.test\.mjs"/)
})
