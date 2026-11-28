import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createHash } from 'node:crypto'

import {
  analyzeMigrationSql,
  applyReviewedExceptions,
  changedMigrationFiles,
  parseReviewedExceptions,
  REVIEWED_EXCEPTIONS_PATH,
  maskSqlComments,
  parseChangedMigrationOutput,
  run as runMigrationSafety,
} from './migration-sql-safety-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECKER = path.join(ROOT, 'scripts', 'qa', 'migration-sql-safety-check.mjs')
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'migration-sql-safety')

function fixture(kind, name) {
  const fixturePath = path.join(FIXTURES, kind, name)
  return { path: fixturePath, source: readFileSync(fixturePath, 'utf8') }
}

function rules(result) {
  return result.map((finding) => finding.rule)
}

function runChecker(args, env = process.env) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  })
}

test('safe fixture permits additive DDL, comments, and NOT NULL with matching defaults', () => {
  const { path: fixturePath, source } = fixture('safe', 'additive.sql')

  assert.deepEqual(analyzeMigrationSql(source, fixturePath), [])
  const result = runChecker([fixturePath])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Migration SQL safety check passed/)
})

test('unsafe fixture blocks DROP and TRUNCATE statements', () => {
  const { path: fixturePath, source } = fixture('unsafe', 'drop-and-truncate.sql')

  assert.deepEqual(rules(analyzeMigrationSql(source, fixturePath)), ['drop', 'drop', 'truncate'])
})

test('unsafe fixture blocks destructive ALTER TABLE actions', () => {
  const { path: fixturePath, source } = fixture('unsafe', 'dangerous-alter.sql')

  assert.deepEqual(rules(analyzeMigrationSql(source, fixturePath)), [
    'drop',
    'drop',
    'alter-column-type',
    'alter-rename',
    'alter-set-schema',
    'alter-detach-partition',
    'alter-disable-trigger',
  ])
})

test('ALTER TABLE review covers optional COLUMN and Unicode identifiers', () => {
  assert.deepEqual(
    rules(analyzeMigrationSql('ALTER TABLE arena.accounts RENAME score TO legacy_score;')),
    ['alter-rename']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        String.raw`ALTER TABLE arena.accounts ALTER COLUMN U&"sc\006fre" TYPE bigint;`
      )
    ),
    ['alter-column-type']
  )
  assert.deepEqual(
    rules(analyzeMigrationSql('ALTER TABLE arena.accounts ALTER COLUMN 得分 TYPE bigint;')),
    ['alter-column-type']
  )
})

test('procedural and dynamic SQL cannot hide TRUNCATE statements', () => {
  assert.deepEqual(rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$;")), [
    'drop',
  ])
  assert.deepEqual(rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE 'TRUNCATE TABLE x'; END $$;")), [
    'truncate',
  ])
  assert.deepEqual(
    rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE format('TRUNCATE TABLE %I', 'x'); END $$;")),
    ['dynamic-sql-review']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        'DO $body$ BEGIN EXECUTE $statement$TRUNCATE TABLE x$statement$; END $body$;'
      )
    ),
    ['truncate']
  )
  assert.deepEqual(rules(analyzeMigrationSql("DO 'BEGIN TRUNCATE TABLE arena.accounts; END';")), [
    'truncate',
  ])
  assert.deepEqual(rules(analyzeMigrationSql("DO E'BEGIN TRUNCATE TABLE arena.accounts; END';")), [
    'encoded-procedural-sql-review',
  ])
  assert.deepEqual(rules(analyzeMigrationSql("DO U&'BEGIN TRUNCATE TABLE arena.accounts; END';")), [
    'encoded-procedural-sql-review',
  ])
  assert.deepEqual(
    rules(analyzeMigrationSql("DO 'BEGIN EXECUTE ''TRUNCATE TABLE arena.accounts''; END';")),
    ['truncate']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        "CREATE FUNCTION arena.clear_accounts() RETURNS void LANGUAGE plpgsql AS 'BEGIN TRUNCATE TABLE arena.accounts; END';"
      )
    ),
    ['truncate']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        'CREATE PROCEDURE arena.clear_accounts() LANGUAGE SQL BEGIN ATOMIC TRUNCATE TABLE arena.accounts; END;'
      )
    ),
    ['truncate']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql("DO $$ BEGIN EXECUTE ('TRUNCATE TABLE arena.' || 'accounts'); END $$;")
    ),
    ['dynamic-sql-review']
  )
  assert.deepEqual(
    rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE('TRUNCATE TABLE arena.accounts'); END $$;")),
    ['truncate']
  )
  assert.deepEqual(
    rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE U&'TRUNCATE TABLE arena.accounts'; END $$;")),
    ['dynamic-sql-review']
  )
  assert.deepEqual(rules(analyzeMigrationSql('DO $$ BEGIN TRUNCATE TABLE x; END $$;')), [
    'truncate',
  ])
  assert.deepEqual(
    rules(
      analyzeMigrationSql(`DO $body$
        BEGIN
          TRUNCATE TABLE x;
        END
      $body$;`)
    ),
    ['truncate']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(`DO $$
        BEGIN
          IF should_clear THEN TRUNCATE TABLE x;
          ELSE TRUNCATE TABLE y;
          END IF;
          LOOP TRUNCATE TABLE z; EXIT; END LOOP;
        END
      $$;`)
    ),
    ['truncate', 'truncate', 'truncate']
  )
  assert.deepEqual(rules(analyzeMigrationSql(String.raw`SELECT '\'; DROP TABLE arena.accounts;`)), [
    'drop',
  ])
  assert.deepEqual(analyzeMigrationSql(String.raw`SELECT E'escaped\' quote';`), [])
})

test('procedural EXECUTE fails closed unless its command is one plain static literal', () => {
  const reviewCases = [
    "DO $$ BEGIN EXECUTE 'TRU' || 'NCATE TABLE arena.accounts'; END $$;",
    "DO $$ BEGIN EXECUTE format('%s TABLE arena.accounts', 'TRUNCATE'); END $$;",
    String.raw`DO $$ BEGIN EXECUTE E'\x54RUNCATE TABLE arena.accounts'; END $$;`,
    String.raw`DO $$ BEGIN EXECUTE U&'\0054RUNCATE TABLE arena.accounts'; END $$;`,
    "DO $$ DECLARE command text := 'TRUNCATE TABLE arena.accounts'; BEGIN EXECUTE command; END $$;",
  ]

  for (const source of reviewCases) {
    assert.deepEqual(rules(analyzeMigrationSql(source)), ['dynamic-sql-review'], source)
  }

  assert.deepEqual(analyzeMigrationSql("DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;"), [])
  assert.deepEqual(analyzeMigrationSql('DO $$ BEGIN EXECUTE $sql$SELECT 1$sql$; END $$;'), [])
  assert.deepEqual(
    rules(analyzeMigrationSql("DO $$ BEGIN EXECUTE (('TRUNCATE TABLE arena.accounts')); END $$;")),
    ['truncate']
  )
})

test('prefixed PL/pgSQL EXECUTE forms cannot bypass dynamic SQL review', () => {
  const prefixedExecuteCases = [
    "DO $$ BEGIN RETURN QUERY EXECUTE 'SEL' || 'ECT 1'; END $$;",
    "DO $$ DECLARE cur refcursor; BEGIN OPEN cur FOR EXECUTE format('%s', 'SELECT 1'); END $$;",
    "DO $$ DECLARE row_data record; command text := 'SELECT 1'; BEGIN FOR row_data IN EXECUTE command LOOP NULL; END LOOP; END $$;",
  ]

  for (const source of prefixedExecuteCases) {
    assert.deepEqual(rules(analyzeMigrationSql(source)), ['dynamic-sql-review'], source)
  }

  assert.deepEqual(
    analyzeMigrationSql("DO $$ BEGIN PERFORM helpers . execute('TRUNCATE TABLE x'); END $$;"),
    []
  )
})

test('E/U& encoded procedural bodies fail closed before escape decoding can hide DDL', () => {
  assert.deepEqual(
    rules(analyzeMigrationSql(String.raw`DO E'BEGIN \x54RUNCATE TABLE arena.accounts; END';`)),
    ['encoded-procedural-sql-review']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        String.raw`CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS U&'BEGIN \0044ROP TABLE arena.accounts; END';`
      )
    ),
    ['encoded-procedural-sql-review']
  )
})

test('safe fixture permits trigger, privilege, TG_OP, array, comment, and identifier contexts', () => {
  const { path: fixturePath, source } = fixture('safe', 'truncate-contexts.sql')

  assert.deepEqual(analyzeMigrationSql(source, fixturePath), [])
  assert.deepEqual(
    analyzeMigrationSql(
      "CREATE FUNCTION arena.safe_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF TG_OP = ''TRUNCATE'' THEN RETURN NULL; END IF; RETURN NULL; END';"
    ),
    []
  )
  assert.deepEqual(
    analyzeMigrationSql(
      "DO $$ BEGIN PERFORM helpers.execute('TRUNCATE TABLE arena.accounts'); END $$;"
    ),
    []
  )
})

test('static EXECUTE SQL reuses NOT NULL safety analysis', () => {
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        "DO $$ BEGIN EXECUTE 'ALTER TABLE arena.accounts ALTER COLUMN score SET NOT NULL'; END $$;"
      )
    ),
    ['not-null-without-default']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        "DO $$ BEGIN EXECUTE 'ALTER TABLE arena.accounts ADD COLUMN enabled boolean NOT NULL'; END $$;"
      )
    ),
    ['not-null-without-default']
  )
  assert.deepEqual(
    analyzeMigrationSql(
      "DO $$ BEGIN EXECUTE 'ALTER TABLE arena.accounts ADD COLUMN enabled boolean NOT NULL DEFAULT false'; END $$;"
    ),
    []
  )
  assert.deepEqual(
    analyzeMigrationSql(
      "DO $$ BEGIN EXECUTE 'ALTER TABLE arena.accounts ALTER COLUMN score SET DEFAULT 0, ALTER COLUMN score SET NOT NULL'; END $$;"
    ),
    []
  )
})

test('unsafe fixture links NOT NULL defaults to the same column or ADD clause', () => {
  const { path: fixturePath, source } = fixture('unsafe', 'not-null-without-default.sql')

  assert.deepEqual(rules(analyzeMigrationSql(source, fixturePath)), [
    'not-null-without-default',
    'not-null-without-default',
    'not-null-without-default',
  ])
})

test('an explicit NULL default never makes a NOT NULL change safe', () => {
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        'ALTER TABLE arena.accounts ALTER COLUMN score SET DEFAULT NULL, ALTER COLUMN score SET NOT NULL;'
      )
    ),
    ['not-null-without-default']
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        'ALTER TABLE arena.accounts ADD COLUMN enabled boolean NOT NULL DEFAULT ((NULL::boolean));'
      )
    ),
    ['not-null-without-default']
  )
})

test('equivalent lower-case quoted identifiers share the same NOT NULL default', () => {
  assert.deepEqual(
    analyzeMigrationSql(
      'ALTER TABLE arena.accounts ALTER COLUMN "score" SET DEFAULT 0, ALTER COLUMN score SET NOT NULL;'
    ),
    []
  )
  assert.deepEqual(
    rules(
      analyzeMigrationSql(
        'ALTER TABLE arena.accounts ALTER COLUMN "Score" SET DEFAULT 0, ALTER COLUMN score SET NOT NULL;'
      )
    ),
    ['not-null-without-default']
  )
})

test('unsafe fixtures make the CLI fail with reviewable file, line, and rule output', () => {
  const fixturePaths = [
    fixture('unsafe', 'drop-and-truncate.sql').path,
    fixture('unsafe', 'dangerous-alter.sql').path,
    fixture('unsafe', 'not-null-without-default.sql').path,
  ]
  const result = runChecker(fixturePaths)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Migration SQL safety check failed/)
  assert.match(result.stderr, /drop-and-truncate\.sql:1 \[drop\]/)
  assert.match(result.stderr, /dangerous-alter\.sql:3 \[alter-column-type\]/)
  assert.match(result.stderr, /not-null-without-default\.sql:2 \[not-null-without-default\]/)
})

test('malformed SQL and operational failures exit 2 instead of becoming a pass', () => {
  assert.throws(() => maskSqlComments('/* never closed'), /unterminated SQL block comment/)

  let nestedDynamicSql = 'TRUNCATE TABLE arena.accounts;'
  for (let level = 0; level < 6; level += 1) {
    nestedDynamicSql =
      `DO $body${level}$ BEGIN EXECUTE $sql${level}$` +
      `${nestedDynamicSql}$sql${level}$; END $body${level}$;`
  }
  assert.throws(() => analyzeMigrationSql(nestedDynamicSql), /dynamic SQL nesting exceeds 4 levels/)

  const missingFile = runChecker(['supabase/migrations/does-not-exist.sql'])
  assert.equal(missingFile.status, 2)
  assert.match(missingFile.stderr, /Migration SQL safety checker error/)

  const invalidBase = runChecker([], {
    ...process.env,
    MIGRATION_SAFETY_BASE_REF: 'definitely-not-a-git-ref',
  })
  assert.equal(invalidBase.status, 2)
  assert.match(invalidBase.stderr, /cannot resolve migration safety base ref/)
})

test('git change parsing scans additions and blocks migration mutation', () => {
  const changed = parseChangedMigrationOutput(
    Buffer.from(
      [
        'A',
        'supabase/migrations/20260804010101_additive.sql',
        'D',
        'supabase/migrations/20260803010101_applied.sql',
        'M',
        'supabase/migrations/20260803010102_modified.sql',
        'T',
        'supabase/migrations/20260803010103_type_changed.sql',
        'R100',
        'supabase/migrations/20260802010101_old.sql',
        'supabase/migrations/20260804010102_renamed.sql',
        '',
      ].join('\0')
    )
  )

  assert.deepEqual(changed.paths, [
    'supabase/migrations/20260804010101_additive.sql',
    'supabase/migrations/20260803010102_modified.sql',
    'supabase/migrations/20260804010102_renamed.sql',
  ])
  assert.deepEqual(
    changed.historyViolations.map(({ rule }) => rule),
    [
      'migration-file-deleted',
      'migration-file-modified',
      'migration-file-modified',
      'migration-file-renamed',
    ]
  )

  const movedOut = parseChangedMigrationOutput(
    Buffer.from(
      ['R100', 'supabase/migrations/20260802010101_old.sql', 'scripts/fixtures/old.sql', ''].join(
        '\0'
      )
    )
  )
  assert.deepEqual(movedOut.paths, [])
  assert.deepEqual(
    movedOut.historyViolations.map(({ rule }) => rule),
    ['migration-file-renamed']
  )
})

test('git migration enumeration is bound to committed HEAD and rejects in-place edits', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'arena-migration-safety-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const migration = 'supabase/migrations/20260803010101_applied.sql'
  const migrationPath = path.join(repo, migration)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'migration-safety@example.com',
        GIT_AUTHOR_NAME: 'Migration Safety',
        GIT_COMMITTER_EMAIL: 'migration-safety@example.com',
        GIT_COMMITTER_NAME: 'Migration Safety',
      },
    }).trim()

  git('init', '-q')
  mkdirSync(path.dirname(migrationPath), { recursive: true })
  writeFileSync(migrationPath, 'SELECT 1;\n')
  git('add', migration)
  git('commit', '-q', '-m', 'baseline migration')
  const base = git('rev-parse', 'HEAD')

  writeFileSync(migrationPath, 'SELECT 2;\n')
  git('add', migration)
  git('commit', '-q', '-m', 'illegally modify migration')
  writeFileSync(migrationPath, 'SELECT 1;\n')

  const changed = changedMigrationFiles(base, repo)
  assert.deepEqual(changed.paths, [migration])
  assert.deepEqual(
    changed.historyViolations.map(({ rule }) => rule),
    ['migration-file-modified']
  )

  git('restore', migration)
  const additiveBase = git('rev-parse', 'HEAD')
  const addedMigration = 'supabase/migrations/20260804010101_dangerous.sql'
  const addedMigrationPath = path.join(repo, addedMigration)
  writeFileSync(addedMigrationPath, 'DROP TABLE arena.accounts;\n')
  git('add', addedMigration)
  git('commit', '-q', '-m', 'add dangerous migration')
  writeFileSync(addedMigrationPath, 'SELECT 1;\n')

  const added = changedMigrationFiles(additiveBase, repo)
  assert.deepEqual(added.paths, [addedMigration])
  assert.deepEqual(added.historyViolations, [])

  const errors = []
  const originalConsoleError = console.error
  console.error = (...values) => errors.push(values.join(' '))
  try {
    assert.equal(
      runMigrationSafety({
        args: [],
        env: { MIGRATION_SAFETY_BASE_REF: additiveBase },
        root: repo,
      }),
      1
    )
  } finally {
    console.error = originalConsoleError
  }
  assert.match(errors.join('\n'), /dangerous\.sql:1 \[drop\]/)
})

const DROP_MIGRATION = 'supabase/migrations/20261201000000_drop_reviewed_index.sql'
const DROP_SOURCE = 'BEGIN;\nDROP INDEX IF EXISTS arena.idx_reviewed;\nCOMMIT;\n'
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const REVIEW =
  'reviewed: drops one never-scanned index; definition preflight and kept-index postflight'

function exception(overrides = {}) {
  return {
    count: 1,
    path: DROP_MIGRATION,
    review: REVIEW,
    rule: 'drop',
    sha256: sha256(DROP_SOURCE),
    ...overrides,
  }
}

test('the reviewed exception list in the repository parses', () => {
  const text = readFileSync(path.join(ROOT, REVIEWED_EXCEPTIONS_PATH), 'utf8')
  assert.ok(Array.isArray(parseReviewedExceptions(text)))
})

test('reviewed exceptions fail closed on any malformed entry', () => {
  const parse = (value) => parseReviewedExceptions(JSON.stringify(value), 'list')
  assert.deepEqual(parse([]), [])
  assert.equal(parse([exception()]).length, 1)
  assert.throws(() => parseReviewedExceptions('{', 'list'), /not valid JSON/)
  assert.throws(() => parse({}), /must be a JSON array/)
  assert.throws(() => parse([{ ...exception(), extra: 1 }]), /must have exactly/)
  assert.throws(
    () => parse([exception({ path: 'supabase/migrations/../x.sql' })]),
    /modern migration/
  )
  assert.throws(() => parse([exception({ path: 'scripts/x.sql' })]), /modern migration/)
  assert.throws(() => parse([exception({ sha256: 'ABC' })]), /64 lowercase hex/)
  assert.throws(
    () => parse([exception({ rule: 'migration-file-modified' })]),
    /rule must be one of: drop/
  )
  assert.throws(() => parse([exception({ rule: 'truncate' })]), /rule must be one of: drop/)
  assert.throws(() => parse([exception({ count: 0 })]), /count must be/)
  assert.throws(() => parse([exception({ count: 1.5 })]), /count must be/)
  assert.throws(() => parse([exception({ review: 'ok' })]), /review must say/)
  assert.throws(() => parse([exception(), exception()]), /duplicates/)
})

test('a reviewed exception waives exactly the reviewed findings of the exact file', () => {
  const findings = analyzeMigrationSql(DROP_SOURCE, DROP_MIGRATION)
  assert.deepEqual(rules(findings), ['drop'])
  const [entry] = parseReviewedExceptions(JSON.stringify([exception()]))

  const applied = []
  assert.deepEqual(
    applyReviewedExceptions(findings, DROP_SOURCE, DROP_MIGRATION, [entry], applied),
    []
  )
  assert.deepEqual(applied, [entry])

  // One byte more: the sha256 no longer matches, the DROP is reported again.
  const edited = DROP_SOURCE + '\n'
  assert.deepEqual(
    rules(
      applyReviewedExceptions(analyzeMigrationSql(edited, DROP_MIGRATION), edited, DROP_MIGRATION, [
        entry,
      ])
    ),
    ['drop', 'reviewed-exception-mismatch']
  )

  // One DROP more under a matching hash: the count does not match.
  const twoDrops = DROP_SOURCE + 'DROP INDEX IF EXISTS arena.idx_other;\n'
  const [twoEntry] = parseReviewedExceptions(
    JSON.stringify([exception({ sha256: sha256(twoDrops) })])
  )
  assert.deepEqual(
    rules(
      applyReviewedExceptions(
        analyzeMigrationSql(twoDrops, DROP_MIGRATION),
        twoDrops,
        DROP_MIGRATION,
        [twoEntry]
      )
    ),
    ['drop', 'drop', 'reviewed-exception-mismatch']
  )

  // Another file, or another rule in the same file, is untouched.
  const other = 'supabase/migrations/20261201000001_other.sql'
  assert.deepEqual(
    rules(
      applyReviewedExceptions(analyzeMigrationSql(DROP_SOURCE, other), DROP_SOURCE, other, [entry])
    ),
    ['drop']
  )
  const withTruncate = DROP_SOURCE + 'TRUNCATE TABLE arena.accounts;\n'
  const [truncEntry] = parseReviewedExceptions(
    JSON.stringify([exception({ sha256: sha256(withTruncate) })])
  )
  assert.deepEqual(
    rules(
      applyReviewedExceptions(
        analyzeMigrationSql(withTruncate, DROP_MIGRATION),
        withTruncate,
        DROP_MIGRATION,
        [truncEntry]
      )
    ),
    ['truncate']
  )
})

test('git mode applies an exception added with its migration, prints it, and refuses a retroactive one', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'arena-migration-safety-reviewed-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'migration-safety@example.com',
        GIT_AUTHOR_NAME: 'Migration Safety',
        GIT_COMMITTER_EMAIL: 'migration-safety@example.com',
        GIT_COMMITTER_NAME: 'Migration Safety',
      },
    }).trim()
  const write = (relativePath, text) => {
    mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true })
    writeFileSync(path.join(repo, relativePath), text)
  }
  const runIn = (base) => {
    const out = []
    const err = []
    const log = console.log
    const error = console.error
    console.log = (...values) => out.push(values.join(' '))
    console.error = (...values) => err.push(values.join(' '))
    try {
      return {
        status: runMigrationSafety({
          args: [],
          env: { MIGRATION_SAFETY_BASE_REF: base },
          root: repo,
        }),
        out: out.join('\n'),
        err: err.join('\n'),
      }
    } finally {
      console.log = log
      console.error = error
    }
  }

  git('init', '-q')
  write('supabase/migrations/20261130000000_old_drop.sql', 'DROP INDEX arena.idx_old;\n')
  write(REVIEWED_EXCEPTIONS_PATH, '[]\n')
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')
  const base = git('rev-parse', 'HEAD')

  // Without an exception the new DROP fails.
  write(DROP_MIGRATION, DROP_SOURCE)
  git('add', DROP_MIGRATION)
  git('commit', '-q', '-m', 'add reviewed drop')
  const withoutException = runIn(base)
  assert.equal(withoutException.status, 1)
  assert.match(withoutException.err, /20261201000000_drop_reviewed_index\.sql:2 \[drop\]/)

  // With the exception in the same diff it passes and the waiver is printed.
  write(REVIEWED_EXCEPTIONS_PATH, JSON.stringify([exception()], null, 2) + '\n')
  git('add', REVIEWED_EXCEPTIONS_PATH)
  git('commit', '-q', '-m', 'record review')
  const withException = runIn(base)
  assert.equal(withException.status, 0, withException.err)
  assert.match(
    withException.out,
    /Reviewed exception applied: supabase\/migrations\/20261201000000_drop_reviewed_index\.sql rule=drop count=1 sha256=[0-9a-f]{64}/
  )

  // A later diff that does not add the migration: the old entry stays inert.
  const reviewedBase = git('rev-parse', 'HEAD')
  write('supabase/migrations/20261202000000_additive.sql', 'SELECT 1;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'unrelated additive migration')
  assert.equal(runIn(reviewedBase).status, 0)

  // A new exception for a migration committed before this diff is refused.
  const retroBase = git('rev-parse', 'HEAD')
  const old = 'supabase/migrations/20261130000000_old_drop.sql'
  write(
    REVIEWED_EXCEPTIONS_PATH,
    JSON.stringify(
      [exception(), exception({ path: old, sha256: sha256('DROP INDEX arena.idx_old;\n') })],
      null,
      2
    ) + '\n'
  )
  git('add', REVIEWED_EXCEPTIONS_PATH)
  git('commit', '-q', '-m', 'retroactive waiver')
  const retro = runIn(retroBase)
  assert.equal(retro.status, 1)
  assert.match(retro.err, /20261130000000_old_drop\.sql:1 \[reviewed-exception-retroactive\]/)

  // A malformed list is an operational failure, not a pass.
  const malformedBase = git('rev-parse', 'HEAD')
  write(REVIEWED_EXCEPTIONS_PATH, '{"not": "a list"}\n')
  git('add', REVIEWED_EXCEPTIONS_PATH)
  git('commit', '-q', '-m', 'malformed')
  assert.throws(
    () =>
      runMigrationSafety({
        args: [],
        env: { MIGRATION_SAFETY_BASE_REF: malformedBase },
        root: repo,
      }),
    /must be a JSON array/
  )
})

test('CI invokes the fail-closed checker directly without shell error suppression', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const start = workflow.indexOf('- name: Migration SQL safety gate')
  assert.notEqual(start, -1, 'migration SQL safety CI step is missing')
  const nextStep = workflow.indexOf('\n      - name:', start + 1)
  const nextJobSection = workflow.indexOf('\n\n  #', start + 1)
  const boundaries = [nextStep, nextJobSection].filter((index) => index >= 0)
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined
  const gate = workflow.slice(start, end)

  assert.match(gate, /set -euo pipefail/)
  assert.match(gate, /MIGRATION_SAFETY_BASE_REF="\$\(jq -r .+ "\$GITHUB_EVENT_PATH"\)"/)
  assert.match(gate, /export MIGRATION_SAFETY_BASE_REF/)
  assert.match(gate, /npm run qa:migration-safety/)
  assert.doesNotMatch(gate, /\$\{\{/)
  assert.doesNotMatch(gate, /\|\|\s*true|continue-on-error|2>\s*\/dev\/null/)
})
