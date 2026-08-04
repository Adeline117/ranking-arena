import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { findDangerousDdl } from './migration-dangerous-ddl-check.mjs'

const scannerPath = fileURLToPath(new URL('./migration-dangerous-ddl-check.mjs', import.meta.url))
const zeroSha = '0'.repeat(40)

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function createRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'arena-migration-lint-'))
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'migration-lint@example.test'])
  git(repo, ['config', 'user.name', 'Migration Lint Test'])
  return repo
}

function writeRepoFile(repo, relativePath, contents) {
  const absolutePath = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

function commitAll(repo, message) {
  git(repo, ['add', '--all'])
  git(repo, ['commit', '--quiet', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

function runScanner(repo, event) {
  const eventPath = path.join(repo, '.migration-lint-event.json')
  writeFileSync(eventPath, JSON.stringify(event))
  return spawnSync(process.execPath, [scannerPath, '--event', eventPath, 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  })
}

function withRepo(callback) {
  const repo = createRepo()
  try {
    callback(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('detects destructive table and column drops', () => {
  const findings = findDangerousDdl(
    [
      'DROP TABLE IF EXISTS public.old_table;',
      'ALTER TABLE public.accounts DROP COLUMN legacy_name;',
    ].join('\n')
  )

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['DROP TABLE', 'DROP COLUMN']
  )
})

test('detects ALTER with optional COLUMN and quoted identifiers', () => {
  const findings = findDangerousDdl(
    [
      'ALTER TABLE public.claims ALTER owner_id SET NOT NULL;',
      'ALTER TABLE public.claims ALTER COLUMN "Owner Id" SET NOT NULL;',
    ].join('\n')
  )

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['ALTER COLUMN SET NOT NULL', 'ALTER COLUMN SET NOT NULL']
  )
})

test('detects every SET NOT NULL after semicolons inside quoted defaults', () => {
  const findings = findDangerousDdl(
    [
      "ALTER TABLE public.claims ALTER COLUMN note SET DEFAULT 'a;b', ALTER COLUMN owner_id SET NOT NULL, ALTER created_at SET NOT NULL;",
      'ALTER TABLE public.claims ALTER COLUMN marker SET DEFAULT $tag$a;b$tag$, ALTER COLUMN "Owner Id" SET NOT NULL;',
    ].join('\n')
  )

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['ALTER COLUMN SET NOT NULL', 'ALTER COLUMN SET NOT NULL', 'ALTER COLUMN SET NOT NULL']
  )
})

test('does not treat comments or safe additive DDL as destructive', () => {
  const findings = findDangerousDdl(
    [
      '-- DROP TABLE public.example;',
      '/* ALTER TABLE public.example',
      '   ALTER COLUMN value SET NOT NULL; */',
      'ALTER TABLE public.claims',
      '  ADD COLUMN submission_version smallint NOT NULL DEFAULT 1;',
    ].join('\n')
  )

  assert.deepEqual(findings, [])
})

test('handles nested block comments without exposing commented DDL', () => {
  const findings = findDangerousDdl(
    [
      '/* outer',
      '  /* DROP COLUMN nested_value */',
      '  DROP TABLE public.hidden;',
      '*/',
      'CREATE TABLE public.visible (id bigint PRIMARY KEY);',
    ].join('\n')
  )

  assert.deepEqual(findings, [])
})

test('E, U&, and dollar-quoted strings cannot hide following DDL', () => {
  const findings = findDangerousDdl(
    [
      "SELECT E'it\\'--still string'; DROP TABLE public.from_e;",
      "SELECT U&'d\\0061--ta'; DROP TABLE public.from_unicode;",
      'SELECT $tag$-- inert literal$tag$; DROP TABLE public.from_dollar;',
    ].join('\n')
  )

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['DROP TABLE', 'DROP TABLE', 'DROP TABLE']
  )
})

test('conservatively scans executable dollar-quoted bodies', () => {
  const findings = findDangerousDdl(
    ['DO $body$', 'BEGIN', "  EXECUTE 'DROP TABLE public.dynamic_target';", 'END', '$body$;'].join(
      '\n'
    )
  )

  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'DROP TABLE')
})

test('fails closed on unterminated comments and quoted values', () => {
  assert.throws(
    () => findDangerousDdl('/* unfinished\nDROP TABLE public.hidden;'),
    /unterminated SQL block comment/
  )
  assert.throws(() => findDangerousDdl("SELECT 'unfinished"), /unterminated SQL quoted value/)
  assert.throws(
    () => findDangerousDdl('SELECT $body$unfinished'),
    /unterminated dollar-quoted string/
  )
})

test('PR events use the merge-base range against the checked-out merge commit', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'base\n')
    const baseSha = commitAll(repo, 'base')
    git(repo, ['switch', '--quiet', '--create', 'feature'])
    writeRepoFile(
      repo,
      'supabase/migrations/20260804010101_pr_danger.sql',
      'DROP TABLE public.pr_target;\n'
    )
    commitAll(repo, 'feature')
    git(repo, ['switch', '--quiet', 'main'])
    git(repo, ['merge', '--quiet', '--no-ff', 'feature', '-m', 'merge feature'])

    const result = runScanner(repo, { pull_request: { base: { sha: baseSha } } })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /DROP TABLE/)
  })
})

test('push events scan every commit in the before-to-after state range', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'base\n')
    const beforeSha = commitAll(repo, 'base')
    writeRepoFile(
      repo,
      'supabase/migrations/20260804010201_safe.sql',
      'CREATE TABLE public.safe_table (id bigint);\n'
    )
    commitAll(repo, 'first push commit')
    writeRepoFile(
      repo,
      'supabase/migrations/20260804010202_danger.sql',
      'DROP COLUMN hidden_value;\n'
    )
    const afterSha = commitAll(repo, 'second push commit')

    const result = runScanner(repo, { before: beforeSha, after: afterSha })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /DROP COLUMN/)
  })
})

test('non-fast-forward push compares exact old and new states rather than three-dot history', () => {
  withRepo((repo) => {
    writeRepoFile(
      repo,
      'supabase/migrations/20260804010301_restored.sql',
      'DROP TABLE public.restored_target;\n'
    )
    const restoredSha = commitAll(repo, 'state containing migration')
    rmSync(path.join(repo, 'supabase/migrations/20260804010301_restored.sql'))
    const beforeSha = commitAll(repo, 'remove migration')
    git(repo, ['branch', 'rewritten', restoredSha])
    git(repo, ['switch', '--quiet', 'rewritten'])

    const result = runScanner(repo, { before: beforeSha, after: restoredSha })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /DROP TABLE/)
  })
})

test('zero before SHA scans the full tree, including a dangerous root commit', () => {
  withRepo((repo) => {
    writeRepoFile(
      repo,
      'supabase/migrations/20260804010401_root.sql',
      'DROP TABLE public.root_target;\n'
    )
    const rootSha = commitAll(repo, 'root')

    const result = runScanner(repo, { before: zeroSha, after: rootSha })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /DROP TABLE/)
  })
})

test('rename from a test fixture into the production migration root is scanned', () => {
  withRepo((repo) => {
    const source = 'supabase/migrations/__tests__/hidden.sql'
    const destination = 'supabase/migrations/20260804010501_renamed.sql'
    writeRepoFile(repo, source, 'DROP TABLE public.renamed_target;\n')
    const beforeSha = commitAll(repo, 'test fixture')
    renameSync(path.join(repo, source), path.join(repo, destination))
    const afterSha = commitAll(repo, 'rename into production')

    const result = runScanner(repo, { before: beforeSha, after: afterSha })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /renamed_target/)
  })
})

test('dangerous SQL below the migration test directory remains excluded', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'base\n')
    const beforeSha = commitAll(repo, 'base')
    writeRepoFile(
      repo,
      'supabase/migrations/__tests__/fixture.sql',
      'DROP TABLE public.fixture_only;\n'
    )
    const afterSha = commitAll(repo, 'test fixture only')

    const result = runScanner(repo, { before: beforeSha, after: afterSha })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /No production migration changes/)
  })
})

test('invalid revisions and push checkout mismatches fail closed', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'first\n')
    const firstSha = commitAll(repo, 'first')
    writeRepoFile(repo, 'README.md', 'second\n')
    const secondSha = commitAll(repo, 'second')

    const missingRevision = runScanner(repo, {
      before: 'a'.repeat(40),
      after: secondSha,
    })
    assert.equal(missingRevision.status, 2)

    const mismatchedCheckout = runScanner(repo, {
      before: zeroSha,
      after: firstSha,
    })
    assert.equal(mismatchedCheckout.status, 2)
    assert.match(mismatchedCheckout.stderr, /does not match checkout HEAD/)
  })
})

test('production migration symlinks are rejected before reading the worktree target', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'not SQL\n')
    const beforeSha = commitAll(repo, 'base')
    const migration = 'supabase/migrations/20260804010601_symlink.sql'
    mkdirSync(path.dirname(path.join(repo, migration)), { recursive: true })
    symlinkSync('../../README.md', path.join(repo, migration))
    const afterSha = commitAll(repo, 'symlink migration')

    const result = runScanner(repo, { before: beforeSha, after: afterSha })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /regular Git blob/)
  })
})

test('scanner reads committed blobs rather than uncommitted worktree content', () => {
  withRepo((repo) => {
    writeRepoFile(repo, 'README.md', 'base\n')
    const beforeSha = commitAll(repo, 'base')
    const migration = 'supabase/migrations/20260804010701_blob.sql'
    writeRepoFile(repo, migration, 'CREATE TABLE public.committed_safe (id bigint);\n')
    const afterSha = commitAll(repo, 'safe migration')
    writeRepoFile(repo, migration, 'DROP TABLE public.uncommitted_only;\n')

    const result = runScanner(repo, { before: beforeSha, after: afterSha })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Migration lint passed/)
  })
})
