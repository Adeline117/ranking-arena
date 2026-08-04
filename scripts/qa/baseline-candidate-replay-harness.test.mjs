import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BASELINE_CANDIDATE_CONTRACT,
  CANDIDATE_STATUS,
  FOUNDATION_CONTRACT,
  FOUNDATION_STATUS,
  FORWARD_MIGRATIONS_CONTRACT,
  PLATFORM_PREREQUISITES_CONTRACT,
  SOURCE_CATALOG_CONTRACT,
  canonicalJsonSha256,
} from './validate-baseline-candidate.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SOURCE_HARNESS = resolve(ROOT, 'scripts/maintenance/replay-baseline-candidate.pg17.sh')
const SOURCE_VALIDATOR = resolve(ROOT, 'scripts/qa/validate-baseline-candidate.mjs')
const SOURCE_SQL_SAFETY = resolve(ROOT, 'scripts/qa/baseline-sql-safety.mjs')
const RESTRICT_KEY = 'a'.repeat(63)
const BASELINE_THROUGH = '20260804000000'
const FORWARD_VERSION = '20260804000001'

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function makeFixture() {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'arena-baseline-harness-repo-'))
  const repoRoot = resolve(tempRoot, 'repo')
  const maintenanceDir = resolve(repoRoot, 'scripts/maintenance')
  const qaDir = resolve(repoRoot, 'scripts/qa')
  const candidatesRoot = resolve(repoRoot, 'supabase/baseline-candidates')
  const foundationsRoot = resolve(repoRoot, 'supabase/baseline-foundations')
  const migrationsRoot = resolve(repoRoot, 'supabase/migrations')
  const id = randomBytes(6).toString('hex')
  const candidate = resolve(candidatesRoot, `replay-test-${id}`)
  const foundation = resolve(foundationsRoot, `replay-test-${id}.sql`)
  const harness = resolve(maintenanceDir, 'replay-baseline-candidate.pg17.sh')

  for (const directory of [maintenanceDir, qaDir, candidate, foundationsRoot, migrationsRoot]) {
    mkdirSync(directory, { recursive: true })
  }
  copyFileSync(SOURCE_HARNESS, harness)
  copyFileSync(SOURCE_VALIDATOR, resolve(qaDir, 'validate-baseline-candidate.mjs'))
  copyFileSync(SOURCE_SQL_SAFETY, resolve(qaDir, 'baseline-sql-safety.mjs'))
  chmodSync(harness, 0o755)

  writeFileSync(foundation, 'CREATE SCHEMA auth;\nCREATE SCHEMA storage;\n')
  writeFileSync(
    resolve(candidate, 'app-schema.sql'),
    `-- PostgreSQL database dump\n\\restrict ${RESTRICT_KEY}\n` +
      `CREATE SCHEMA arena;\n\\unrestrict ${RESTRICT_KEY}\n`
  )
  const boundarySql = 'SELECT 1;\n'
  const boundaryRepoPath = `supabase/migrations/${BASELINE_THROUGH}_fixture_boundary.sql`
  const boundaryPath = resolve(repoRoot, boundaryRepoPath)
  const forwardSql = 'CREATE TABLE arena.forward_fixture (id bigint PRIMARY KEY);\n'
  const forwardRepoPath = `supabase/migrations/${FORWARD_VERSION}_fixture_forward.sql`
  const forwardPath = resolve(repoRoot, forwardRepoPath)
  writeFileSync(boundaryPath, boundarySql)
  writeFileSync(forwardPath, forwardSql)
  const migrations = [
    {
      path: forwardRepoPath,
      sha256: sha256(forwardSql),
      version: FORWARD_VERSION,
    },
  ]
  const repositoryMigrations = [
    {
      path: boundaryRepoPath,
      sha256: sha256(boundarySql),
      version: BASELINE_THROUGH,
    },
    ...migrations,
  ]
  writeJson(resolve(candidate, 'forward-migrations.json'), {
    baselineThrough: BASELINE_THROUGH,
    contract: FORWARD_MIGRATIONS_CONTRACT,
    migrationSetSha256: canonicalJsonSha256(migrations),
    migrations,
    repositoryMigrationSetSha256: canonicalJsonSha256(repositoryMigrations),
  })
  const catalog = {
    acls: [],
    columns: [],
    constraints: [],
    defaultPrivileges: [],
    extensions: [],
    functions: [],
    indexes: [],
    policies: [],
    publications: [],
    schemas: [],
    tables: [],
    triggers: [],
    types: [],
    views: [],
  }
  const ledger = [
    {
      name: 'fixture_boundary',
      statementsSha256: sha256(boundarySql),
      version: BASELINE_THROUGH,
    },
  ]
  writeJson(resolve(candidate, 'source-catalog.json'), {
    capturedAt: '2026-08-04T21:30:00.000Z',
    catalog,
    contract: SOURCE_CATALOG_CONTRACT,
    ledger,
    postgresMajor: 17,
  })
  const prerequisites = {
    contract: PLATFORM_PREREQUISITES_CONTRACT,
    extensions: [],
    functions: [],
    postgresMajor: 17,
    relations: [],
    roles: [],
    schemas: ['auth', 'storage'],
    types: [],
  }
  writeJson(resolve(candidate, 'platform-prerequisites.json'), prerequisites)

  const fixture = {
    candidate,
    candidatesRoot,
    catalog,
    foundation,
    forwardRepoPath,
    harness,
    ledger,
    prerequisites,
    repoRoot,
    tempRoot,
  }
  refreshManifest(fixture)
  return fixture
}

function refreshManifest(fixture) {
  const files = {}
  for (const file of [
    'app-schema.sql',
    'forward-migrations.json',
    'platform-prerequisites.json',
    'source-catalog.json',
  ]) {
    files[file] = sha256(readFileSync(resolve(fixture.candidate, file)))
  }
  writeJson(resolve(fixture.candidate, 'manifest.json'), {
    contract: BASELINE_CANDIDATE_CONTRACT,
    files,
    foundation: {
      contract: FOUNDATION_CONTRACT,
      path: relative(fixture.repoRoot, fixture.foundation).split('\\').join('/'),
      postgresMajor: 17,
      sha256: sha256(readFileSync(fixture.foundation)),
      status: FOUNDATION_STATUS,
    },
    postgresMajor: 17,
    source: {
      capturedAt: '2026-08-04T21:30:00.000Z',
      catalogSha256: canonicalJsonSha256(fixture.catalog),
      gitSha: 'a'.repeat(40),
      ledgerSha256: canonicalJsonSha256(fixture.ledger),
      projectRefSha256: 'b'.repeat(64),
      transport: 'session-or-direct/verify-full/read-only',
    },
    status: CANDIDATE_STATUS,
  })
}

function makeFakePg17() {
  const root = mkdtempSync(resolve(tmpdir(), 'arena-fake-pg17-'))
  const bin = resolve(root, 'bin')
  const state = resolve(root, 'state')
  const shell = `#!/usr/bin/env bash
set -Eeuo pipefail
name="$(basename "$0")"
if [[ "\${1:-}" == '--version' ]]; then
  version="\${FAKE_PG_VERSION:-17.9}"
  if [[ "$name" == 'postgres' ]]; then
    version="\${FAKE_POSTGRES_VERSION:-$version}"
  fi
  printf '%s (PostgreSQL) %s\n' "$name" "$version"
  exit 0
fi
printf '%s\t%s\n' "$name" "$*" >> "$FAKE_PG_CALLS"
data_dir=''
operation=''
arguments=("$@")
for ((index = 0; index < \${#arguments[@]}; index += 1)); do
  if [[ "\${arguments[$index]}" == '-D' ]]; then data_dir="\${arguments[$((index + 1))]}"; fi
  case "\${arguments[$index]}" in start|stop|status) operation="\${arguments[$index]}" ;; esac
done
if [[ "$name" == 'initdb' ]]; then
  mkdir -p "$data_dir"
elif [[ "$name" == 'pg_ctl' ]]; then
  if [[ "$operation" == 'start' ]]; then
    if [[ "\${FAKE_PG_START_FAIL_AFTER_PID:-0}" == '1' ]]; then
      printf '99999\n' > "$data_dir/postmaster.pid"
      exit 18
    fi
    printf '99999\n' > "$data_dir/postmaster.pid"
  elif [[ "$operation" == 'status' ]]; then
    [[ -s "$data_dir/postmaster.pid" ]]
  elif [[ "$operation" == 'stop' ]]; then
    [[ "\${FAKE_PG_STOP_FAIL:-0}" != '1' ]] || exit 20
    if [[ -n "\${FAKE_PG_SIGNAL_PARENT_ON_STOP:-}" ]]; then
      kill -"$FAKE_PG_SIGNAL_PARENT_ON_STOP" "$PPID"
    fi
    rm -f -- "$data_dir/postmaster.pid"
  fi
elif [[ "$name" == 'psql' ]]; then
  sql_file=''
  query_mode=0
  for ((index = 0; index < \${#arguments[@]}; index += 1)); do
    if [[ "\${arguments[$index]}" == '-f' ]]; then sql_file="\${arguments[$((index + 1))]}"; fi
    if [[ "\${arguments[$index]}" == '-At' ]]; then query_mode=1; fi
  done
  if [[ "$query_mode" == '1' ]]; then
    query_count=0
    if [[ -f "$FAKE_PSQL_QUERY_COUNT" ]]; then
      read -r query_count < "$FAKE_PSQL_QUERY_COUNT"
    fi
    query_count=$((query_count + 1))
    printf '%s\n' "$query_count" > "$FAKE_PSQL_QUERY_COUNT"
    if [[ "$query_count" == '1' ]]; then
      printf '%s\n' "$FAKE_PREREQUISITES_BEFORE_JSON"
    else
      printf '%s\n' "$FAKE_PREREQUISITES_JSON"
    fi
  elif [[ -n "$sql_file" ]]; then
    printf '%s\n' "$sql_file" >> "$FAKE_PSQL_FILES"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$HOME" "$XDG_CONFIG_HOME" "$PGPASSFILE" "$PGSERVICEFILE" "$PSQL_PAGER" "\${CDPATH:-}" \
      >> "$FAKE_PSQL_ENVIRONMENTS"
    if [[ -n "\${FAKE_PSQL_FAIL_BASENAME:-}" && "$(basename "$sql_file")" == "$FAKE_PSQL_FAIL_BASENAME" ]]; then
      exit 19
    fi
  fi
fi
`

  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  for (const executable of ['initdb', 'pg_ctl', 'postgres', 'psql']) {
    const file = resolve(bin, executable)
    writeFileSync(file, shell)
    chmodSync(file, 0o755)
  }

  return {
    bin,
    calls: resolve(state, 'calls.log'),
    environments: resolve(state, 'psql-environments.log'),
    files: resolve(state, 'psql-files.log'),
    queryCount: resolve(state, 'psql-query-count'),
    root,
  }
}

function cleanEnvironment(fake, tempParent, overrides = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith('PG') && key !== 'PG17_BIN') ||
      key.includes('DATABASE_URL') ||
      key === 'DIRECT_URL' ||
      key === 'POSTGRES_URL' ||
      key.startsWith('POSTGRES_URL_') ||
      key === 'SUPABASE_DB_URL'
    ) {
      delete env[key]
    }
  }
  delete env.NODE_OPTIONS
  return {
    ...env,
    FAKE_PG_CALLS: fake.calls,
    FAKE_PSQL_ENVIRONMENTS: fake.environments,
    FAKE_PSQL_FILES: fake.files,
    FAKE_PSQL_QUERY_COUNT: fake.queryCount,
    FAKE_PREREQUISITES_BEFORE_JSON: JSON.stringify({
      appOwnedRelations: 0,
      appOwnedRoutines: 0,
      appOwnedSchemas: 0,
      appOwnedTypes: 0,
      extensions: [],
      functions: [],
      relations: [],
      roles: [],
      schemas: [],
      types: [],
    }),
    FAKE_PREREQUISITES_JSON: JSON.stringify({
      appOwnedRelations: 0,
      appOwnedRoutines: 0,
      appOwnedSchemas: 0,
      appOwnedTypes: 0,
      extensions: [],
      functions: [],
      relations: [],
      roles: [],
      schemas: ['auth', 'storage'],
      types: [],
    }),
    PG17_BIN: fake.bin,
    TMPDIR: tempParent,
    ...overrides,
  }
}

function args(fixture, candidate = relative(fixture.repoRoot, fixture.candidate)) {
  return [fixture.harness, '--candidate-dir', candidate]
}

function run(fixture, fake, tempParent, env = {}, candidate) {
  return spawnSync('bash', args(fixture, candidate), {
    cwd: fixture.repoRoot,
    encoding: 'utf8',
    env: cleanEnvironment(fake, tempParent, env),
  })
}

function remove(...directories) {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
}

function removeOnlyIfEmpty(directory) {
  if (!existsSync(directory)) return
  try {
    rmdirSync(directory)
  } catch (error) {
    if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
  }
}

function validatePreservedDirectory(directory, expectedParent, namePattern, label) {
  const absolute = resolve(directory)
  assert.equal(
    realpathSync(dirname(absolute)),
    realpathSync(expectedParent),
    `${label} escaped its exact physical parent`
  )
  assert.match(basename(absolute), namePattern, `${label} has an unexpected name`)
  const stat = lstatSync(absolute)
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`)
  assert.equal(stat.isDirectory(), true, `${label} must be a directory`)
  return absolute
}

function removePreservedHarnessRoots(clusterRoot, socketRoot, tempParent) {
  const cluster = validatePreservedDirectory(
    clusterRoot,
    tempParent,
    /^arena-baseline-replay-pg17\.[A-Za-z0-9]+$/u,
    'preserved cluster root'
  )
  const socket = validatePreservedDirectory(
    socketRoot,
    '/tmp',
    /^arena-baseline-pg17-socket\.[A-Za-z0-9]+$/u,
    'preserved socket root'
  )
  remove(cluster, socket)
}

function socketRootFromStartCall(startCall) {
  const match = startCall.match(/-k '([^']+)'/u)
  assert.ok(match, 'pg_ctl start must pin a private Unix socket root')
  return match[1]
}

test('replay is inert without its exact disposable opt-in', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ARENA_DISPOSABLE_BASELINE_REPLAY=1 is required/)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('replay rejects mixed tools, psql before 17.6, and external connection environment', async (t) => {
  for (const [name, env, message] of [
    [
      'mismatched postgres server',
      { ARENA_DISPOSABLE_BASELINE_REPLAY: '1', FAKE_POSTGRES_VERSION: '17.8' },
      /PostgreSQL tools must have one exact version.*postgres=17\.8/,
    ],
    [
      'PostgreSQL 17.5',
      { ARENA_DISPOSABLE_BASELINE_REPLAY: '1', FAKE_PG_VERSION: '17.5' },
      /17\.6 or newer/,
    ],
    [
      'DATABASE_URL',
      { ARENA_DISPOSABLE_BASELINE_REPLAY: '1', DATABASE_URL: 'postgres://remote.invalid/db' },
      /external database environment is not allowed: DATABASE_URL/,
    ],
    [
      'PGHOST',
      { ARENA_DISPOSABLE_BASELINE_REPLAY: '1', PGHOST: 'remote.invalid' },
      /external database environment is not allowed: PGHOST/,
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      const fake = makeFakePg17()
      const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
      try {
        const result = run(fixture, fake, tempParent, env)
        assert.equal(result.status, 1)
        assert.match(result.stderr, message)
        assert.deepEqual(readdirSync(tempParent), [])
      } finally {
        remove(fixture.tempRoot, fake.root, tempParent)
      }
    })
  }
})

test('replay rejects nested, symlinked, and hash-drifted candidates before initdb', async (t) => {
  for (const scenario of ['nested', 'symlink', 'hash drift']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      const fake = makeFakePg17()
      const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
      let candidate
      try {
        if (scenario === 'nested') {
          const nested = resolve(fixture.candidate, 'nested')
          mkdirSync(nested)
          candidate = relative(fixture.repoRoot, nested)
        } else if (scenario === 'symlink') {
          const link = resolve(fixture.candidatesRoot, 'replay-test-link')
          symlinkSync(fixture.candidate, link)
          candidate = relative(fixture.repoRoot, link)
        } else {
          writeFileSync(resolve(fixture.candidate, 'app-schema.sql'), 'CREATE SCHEMA changed;\n')
        }
        const result = run(
          fixture,
          fake,
          tempParent,
          { ARENA_DISPOSABLE_BASELINE_REPLAY: '1' },
          candidate
        )
        assert.equal(result.status, 1)
        assert.match(result.stderr, /direct child|must not be a symlink|digest does not match/)
        const calls = existsSync(fake.calls) ? readFileSync(fake.calls, 'utf8') : ''
        assert.equal(calls.includes('initdb'), false)
        assert.deepEqual(readdirSync(tempParent), [])
      } finally {
        remove(fixture.tempRoot, fake.root, tempParent)
      }
    })
  }
})

test('replay stages attested bytes, uses a private socket, and checks prerequisites before app SQL', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
    })
    assert.equal(result.status, 0, result.stderr)
    const files = readFileSync(fake.files, 'utf8').trim().split('\n')
    assert.equal(files.length, 3)
    assert.match(files[0], /\/staged\/foundation\.sql$/)
    assert.match(files[1], /\/staged\/app-schema\.sql$/)
    assert.match(
      files[2],
      new RegExp(`/staged/${FORWARD_VERSION}_${FORWARD_VERSION}_fixture_forward\\.sql$`, 'u')
    )
    assert.equal(
      files.some(
        (file) =>
          file.startsWith(fixture.candidate) ||
          file === resolve(fixture.repoRoot, fixture.forwardRepoPath)
      ),
      false
    )

    const calls = readFileSync(fake.calls, 'utf8').trim().split('\n')
    const start = calls.find((line) => line.startsWith('pg_ctl\t') && line.includes(' start'))
    assert.ok(start)
    assert.match(start, /listen_addresses=''/)
    assert.match(start, /arena-baseline-pg17-socket/)
    assert.equal(start.includes(` -p ${fake.bin}/postgres `), true)
    const socketRoot = socketRootFromStartCall(start)
    const psqlCalls = calls.filter((line) => line.startsWith('psql\t'))
    assert.equal(psqlCalls.length, 5)
    assert.equal(
      psqlCalls.filter((call) => call.includes('-At -c SELECT json_build_object')).length,
      2
    )
    for (const call of psqlCalls) assert.match(call, /-h \/tmp\/arena-baseline-pg17-socket/)
    const fileCalls = psqlCalls.filter((call) => call.includes(' -f '))
    assert.equal(fileCalls.length, 3)
    for (const call of fileCalls) {
      assert.match(call, / -X -w -P pager=off -v ON_ERROR_STOP=1 --single-transaction -f /u)
    }

    const environments = readFileSync(fake.environments, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
    assert.equal(environments.length, 3)
    for (const [home, xdgConfigHome, pgpassfile, pgservicefile, pager, cdpath] of environments) {
      assert.equal(basename(home), 'home')
      assert.equal(dirname(dirname(home)), realpathSync(tempParent))
      assert.match(basename(dirname(home)), /^arena-baseline-replay-pg17\.[A-Za-z0-9]+$/u)
      assert.equal(xdgConfigHome, home)
      assert.equal(pgpassfile, resolve(home, '.pgpass'))
      assert.equal(pgservicefile, resolve(home, '.pg_service.conf'))
      assert.equal(pager, '')
      assert.equal(cdpath, '')
    }
    assert.ok(calls.some((line) => /pg_ctl\t-D .* -m immediate -w stop/.test(line)))
    assert.match(result.stdout, /dependency replay passed \(not promotion evidence\)/)
    assert.deepEqual(readdirSync(tempParent), [])
    assert.equal(existsSync(socketRoot), false)
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('missing foundation prerequisites fail before app SQL and still stop and clean PostgreSQL', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_PREREQUISITES_JSON: JSON.stringify({
        appOwnedRelations: 0,
        appOwnedRoutines: 0,
        appOwnedSchemas: 0,
        appOwnedTypes: 0,
        extensions: [],
        functions: [],
        relations: [],
        roles: [],
        schemas: ['auth'],
        types: [],
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /foundation schemas delta does not match.*storage/)
    assert.deepEqual(readFileSync(fake.files, 'utf8').trim().split('\n').length, 1)
    assert.match(readFileSync(fake.calls, 'utf8'), /pg_ctl\t-D .* -m immediate -w stop/)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('undeclared foundation catalog additions fail the exact delta check', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_PREREQUISITES_JSON: JSON.stringify({
        appOwnedRelations: 0,
        appOwnedRoutines: 0,
        appOwnedSchemas: 0,
        appOwnedTypes: 0,
        extensions: [],
        functions: [],
        relations: ['auth.undeclared_relation'],
        roles: [],
        schemas: ['auth', 'storage'],
        types: [],
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /foundation relations delta does not match.*undeclared_relation/)
    assert.deepEqual(readFileSync(fake.files, 'utf8').trim().split('\n').length, 1)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('a failed app SQL file stops PostgreSQL and removes only the exact temporary roots', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_PSQL_FAIL_BASENAME: 'app-schema.sql',
    })
    assert.equal(result.status, 19)
    assert.match(readFileSync(fake.calls, 'utf8'), /pg_ctl\t-D .* -m immediate -w stop/)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('a start failure after postmaster.pid triggers a stop attempt before cleanup', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_PG_START_FAIL_AFTER_PID: '1',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PostgreSQL failed to start/)
    assert.match(readFileSync(fake.calls, 'utf8'), /pg_ctl\t-D .* -m immediate -w stop/)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('a failed PostgreSQL stop preserves the exact cluster for manual recovery', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_PG_STOP_FAIL: '1',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PostgreSQL stop failed; preserving/)
    assert.equal(readdirSync(tempParent).length, 1)
    const match = result.stderr.match(/preserving (\S+) and (\S+)/u)
    assert.ok(match)
    removePreservedHarnessRoots(match[1], match[2], tempParent)
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent)
  }
})

test('cleanup ignores HUP, INT, and TERM until stop verification and deletion finish', async (t) => {
  for (const signal of ['HUP', 'INT', 'TERM']) {
    await t.test(signal, () => {
      const fixture = makeFixture()
      const fake = makeFakePg17()
      const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
      try {
        const result = run(fixture, fake, tempParent, {
          ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
          FAKE_PG_SIGNAL_PARENT_ON_STOP: signal,
        })
        assert.equal(result.status, 0, result.stderr)
        const calls = readFileSync(fake.calls, 'utf8').trim().split('\n')
        const start = calls.find((line) => line.startsWith('pg_ctl\t') && line.includes(' start'))
        assert.ok(start)
        assert.equal(existsSync(socketRootFromStartCall(start)), false)
        assert.deepEqual(readdirSync(tempParent), [])
      } finally {
        remove(fixture.tempRoot, fake.root, tempParent)
      }
    })
  }
})

test('a failed second temporary-root allocation cannot leak the first root', () => {
  const fixture = makeFixture()
  const fake = makeFakePg17()
  const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-tmp-'))
  const wrapperRoot = mkdtempSync(resolve(tmpdir(), 'arena-replay-wrapper-'))
  const wrapper = resolve(wrapperRoot, 'mktemp')
  const countFile = resolve(wrapperRoot, 'count')
  const lookup = spawnSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' })
  assert.equal(lookup.status, 0, lookup.stderr)
  const realMktemp = lookup.stdout.trim()
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -Eeuo pipefail
count=0
if [[ -s "$FAKE_MKTEMP_COUNT" ]]; then read -r count < "$FAKE_MKTEMP_COUNT"; fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_MKTEMP_COUNT"
if [[ "$count" == '2' ]]; then exit 71; fi
exec "$FAKE_REAL_MKTEMP" "$@"
`
  )
  chmodSync(wrapper, 0o755)
  try {
    const result = run(fixture, fake, tempParent, {
      ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      FAKE_MKTEMP_COUNT: countFile,
      FAKE_REAL_MKTEMP: realMktemp,
      PATH: `${wrapperRoot}:${process.env.PATH ?? ''}`,
    })
    assert.equal(result.status, 71, result.stderr)
    assert.deepEqual(readdirSync(tempParent), [])
  } finally {
    remove(fixture.tempRoot, fake.root, tempParent, wrapperRoot)
  }
})

test(
  'real PostgreSQL 17 dependency replay is available as an explicit local integration check',
  { skip: process.env.ARENA_REAL_BASELINE_PG17_TEST !== '1' },
  () => {
    const fixture = makeFixture()
    writeFileSync(
      fixture.foundation,
      'CREATE SCHEMA auth;\n' +
        'CREATE SCHEMA storage;\n' +
        "CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2');\n" +
        'CREATE TABLE auth.users (id uuid PRIMARY KEY, level auth.aal_level NOT NULL);\n'
    )
    fixture.prerequisites.relations = ['auth.users']
    fixture.prerequisites.types = ['auth.aal_level']
    writeJson(resolve(fixture.candidate, 'platform-prerequisites.json'), fixture.prerequisites)
    refreshManifest(fixture)
    const tempParent = mkdtempSync(resolve(tmpdir(), 'arena-replay-real-tmp-'))
    const state = mkdtempSync(resolve(tmpdir(), 'arena-replay-real-state-'))
    const realPg = {
      bin: process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin',
      calls: resolve(state, 'unused-calls.log'),
      environments: resolve(state, 'unused-environments.log'),
      files: resolve(state, 'unused-files.log'),
      queryCount: resolve(state, 'unused-query-count'),
    }
    let result
    try {
      result = run(fixture, realPg, tempParent, {
        ARENA_DISPOSABLE_BASELINE_REPLAY: '1',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /dependency replay passed \(not promotion evidence\)/)
      assert.deepEqual(readdirSync(tempParent), [])
    } finally {
      remove(fixture.tempRoot, state)
      removeOnlyIfEmpty(tempParent)
      if (existsSync(tempParent)) {
        process.stderr.write(
          `Real PostgreSQL replay left a non-empty temporary parent for fail-safe recovery: ${tempParent}\n` +
            (result?.stderr ?? '')
        )
      }
    }
  }
)
