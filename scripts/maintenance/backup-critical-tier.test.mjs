import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import {
  assertCriticalCoverage,
  buildPgDumpArgs,
  decryptFileToStream,
  DERIVED_TABLE_DATA_PATTERNS,
  encryptStreamToFile,
  parseTableDataEntries,
  REQUIRED_TABLE_DATA,
  runBackup,
  verifyBackupFile,
} from './backup-critical-tier.mjs'

const PASSPHRASE = 'correct horse battery staple, long enough to pass'

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function decryptToBuffer(file, passphrase) {
  const sink = new PassThrough()
  const collected = collect(sink)
  collected.catch(() => {}) // a failed decrypt destroys the sink; surface only that error
  await decryptFileToStream(file, sink, passphrase)
  return collected
}

test('encrypts without leaving plaintext and round-trips exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'critical-tier-'))
  try {
    const plaintext = Buffer.from('user_profiles row: someone@example.com\n'.repeat(5000))
    const file = join(dir, 'a.enc')
    await encryptStreamToFile(Readable.from([plaintext]), file, PASSPHRASE)

    const stored = readFileSync(file)
    assert.equal(stored.includes(Buffer.from('someone@example.com')), false)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(await decryptToBuffer(file, PASSPHRASE), plaintext)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a wrong passphrase, tampering, truncation and a short passphrase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'critical-tier-'))
  try {
    const file = join(dir, 'a.enc')
    await encryptStreamToFile(Readable.from([Buffer.alloc(4096, 7)]), file, PASSPHRASE)

    await assert.rejects(decryptToBuffer(file, `${PASSPHRASE}!`))

    const tampered = readFileSync(file)
    tampered[tampered.length - 100] ^= 0xff
    const tamperedFile = join(dir, 'tampered.enc')
    writeFileSync(tamperedFile, tampered)
    await assert.rejects(decryptToBuffer(tamperedFile, PASSPHRASE))

    const truncatedFile = join(dir, 'truncated.enc')
    writeFileSync(truncatedFile, readFileSync(file).subarray(0, 20))
    await assert.rejects(decryptToBuffer(truncatedFile, PASSPHRASE), /truncated/)

    await assert.rejects(
      encryptStreamToFile(Readable.from([Buffer.from('x')]), join(dir, 'b.enc'), 'short'),
      /at least 32 characters/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('never excludes user-owned trader tables by wildcard', () => {
  const args = buildPgDumpArgs()
  assert.ok(args.includes('--schema=auth') && args.includes('--schema=public'))
  for (const userTable of ['trader_follows', 'trader_watchlist', 'trader_claims']) {
    for (const pattern of DERIVED_TABLE_DATA_PATTERNS) {
      const table = pattern.split('.')[1]
      const matches = table.endsWith('*')
        ? userTable.startsWith(table.slice(0, -1))
        : userTable === table
      assert.equal(matches, false, `${pattern} would drop ${userTable}`)
    }
  }
})

test('coverage check demands every critical relation and no derived data', () => {
  const listing = [
    ';',
    '; Archive created at 2026-11-13',
    ...REQUIRED_TABLE_DATA.map(
      (relation, index) => `${5000 + index}; 0 ${16000 + index} TABLE DATA ${relation} postgres`
    ),
    '4100; 1259 17000 TABLE public trader_equity_curve postgres',
  ].join('\n')
  const entries = parseTableDataEntries(listing)
  assert.equal(entries.size, REQUIRED_TABLE_DATA.length)
  assert.doesNotThrow(() => assertCriticalCoverage(entries))

  const withoutPosts = new Set(entries)
  withoutPosts.delete('public posts')
  assert.throws(() => assertCriticalCoverage(withoutPosts), /missing data for: public posts/)

  const withDerived = new Set(entries).add('public tph_2026_05')
  assert.throws(() => assertCriticalCoverage(withDerived), /not excluded: public tph_2026_05/)
})

const PG_BIN = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'

test(
  'backs up a live PostgreSQL 17 database end to end and can be restored',
  { skip: !existsSync(join(PG_BIN, 'initdb')) && 'PostgreSQL 17 binaries not installed' },
  async () => {
    const root = mkdtempSync('/tmp/critical-tier-pg17.')
    const data = join(root, 'data')
    const socket = join(root, 's')
    const port = String(58000 + (process.pid % 1000))
    const psql = (db, sql) =>
      execFileSync(
        join(PG_BIN, 'psql'),
        ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-d', db, '-Atqc', sql],
        { encoding: 'utf8' }
      )
    execFileSync('mkdir', ['-p', socket])
    execFileSync(
      join(PG_BIN, 'initdb'),
      ['-D', data, '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale'],
      { stdio: 'ignore' }
    )
    execFileSync(
      join(PG_BIN, 'pg_ctl'),
      [
        '-D',
        data,
        '-l',
        join(root, 'log'),
        '-o',
        `-F -p ${port} -k ${socket} -c listen_addresses=`,
        '-w',
        'start',
      ],
      { stdio: 'ignore' }
    )
    const previousPgBin = process.env.PG_BIN
    process.env.PG_BIN = PG_BIN
    try {
      psql(
        'postgres',
        `CREATE SCHEMA auth;
         CREATE TABLE auth.users (id int PRIMARY KEY, email text);
         CREATE TABLE auth.identities (id int PRIMARY KEY, user_id int);
         CREATE TABLE public.user_profiles (id int PRIMARY KEY, email text);
         CREATE TABLE public.posts (id int PRIMARY KEY, body text);
         CREATE TABLE public.comments (id int PRIMARY KEY);
         CREATE TABLE public.groups (id int PRIMARY KEY);
         CREATE TABLE public.group_members (id int PRIMARY KEY);
         CREATE TABLE public.subscriptions (id int PRIMARY KEY);
         CREATE TABLE public.trader_follows (id int PRIMARY KEY, trader_id text);
         CREATE TABLE public.trader_equity_curve (id int PRIMARY KEY, v numeric);
         CREATE TABLE public.tph_2026_05 (id int PRIMARY KEY);
         INSERT INTO auth.users VALUES (1, 'owner@example.com');
         INSERT INTO auth.identities VALUES (1, 1);
         INSERT INTO public.user_profiles VALUES (1, 'owner@example.com');
         INSERT INTO public.posts VALUES (1, 'first post');
         INSERT INTO public.comments VALUES (1);
         INSERT INTO public.groups VALUES (1);
         INSERT INTO public.group_members VALUES (1);
         INSERT INTO public.subscriptions VALUES (1);
         INSERT INTO public.trader_follows VALUES (1, 'trader-1');
         INSERT INTO public.trader_equity_curve SELECT g, g FROM generate_series(1, 2000) g;
         INSERT INTO public.tph_2026_05 SELECT g FROM generate_series(1, 2000) g;`
      )
      const databaseUrl = `postgresql://${process.env.USER}@localhost:${port}/postgres?host=${encodeURIComponent(socket)}`
      const outDir = join(root, 'out')
      const result = await runBackup({ databaseUrl, passphrase: PASSPHRASE, outDir })

      assert.deepEqual(readdirSync(outDir), [result.file.split('/').at(-1)])
      assert.match(result.sha256, /^[0-9a-f]{64}$/)
      assert.equal(readFileSync(result.file).includes(Buffer.from('owner@example.com')), false)
      assert.equal((await verifyBackupFile(result.file, PASSPHRASE)).tableDataEntries, 9)

      // Restore drill: users and content come back; derived tables exist but are empty.
      const sink = new PassThrough()
      const dumped = collect(sink)
      await decryptFileToStream(result.file, sink, PASSPHRASE)
      psql('postgres', 'CREATE DATABASE restored')
      psql('restored', 'DROP SCHEMA public') // the dump recreates it
      const restore = spawnSync(
        join(PG_BIN, 'pg_restore'),
        ['-h', socket, '-p', port, '-d', 'restored', '--no-owner'],
        { input: await dumped }
      )
      assert.equal(restore.status, 0, restore.stderr?.toString())
      assert.equal(
        psql(
          'restored',
          `SELECT (SELECT email FROM auth.users) || '|' || (SELECT body FROM public.posts) || '|' || (SELECT trader_id FROM public.trader_follows) || '|' || (SELECT count(*) FROM public.trader_equity_curve) || '|' || (SELECT count(*) FROM public.tph_2026_05)`
        ).trim(),
        'owner@example.com|first post|trader-1|0|0'
      )
    } finally {
      if (previousPgBin === undefined) delete process.env.PG_BIN
      else process.env.PG_BIN = previousPgBin
      spawnSync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'])
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('splits a connection URI into libpq variables instead of a literal PGDATABASE', async () => {
  const { libpqEnvFromConnectionUrl } = await import('./postgres-cli-env.mjs')

  assert.deepEqual(
    libpqEnvFromConnectionUrl('postgresql://backup%40ops@db.example.com:6543/app?sslmode=require'),
    {
      PGDATABASE: 'app',
      PGHOST: 'db.example.com',
      PGPORT: '6543',
      PGUSER: 'backup@ops',
      PGSSLMODE: 'require',
    }
  )
  // A unix-socket directory given as ?host= overrides the URI host.
  assert.equal(
    libpqEnvFromConnectionUrl('postgresql://me@localhost:5433/app?host=%2Ftmp%2Fsock').PGHOST,
    '/tmp/sock'
  )
  assert.throws(() => libpqEnvFromConnectionUrl('postgresql://me@h/'), /exactly one database/)
  assert.throws(
    () => libpqEnvFromConnectionUrl('postgresql://me@h/a?service=x'),
    /unsupported option/
  )
  assert.throws(() => libpqEnvFromConnectionUrl('mysql://me@h/a'), /postgres or postgresql/)
})
