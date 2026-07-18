#!/usr/bin/env node

/**
 * Launch psql without placing DATABASE_URL (or any credential derived from it)
 * in the child process arguments.
 *
 * libpq does not expand a connection URI supplied through PGDATABASE; it
 * treats that value as a literal database name. Parse the URI here and pass
 * the individual libpq environment variables instead.
 */

import { spawn } from 'node:child_process'

const QUERY_ENV = new Map([
  ['application_name', 'PGAPPNAME'],
  ['channel_binding', 'PGCHANNELBINDING'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['gssencmode', 'PGGSSENCMODE'],
  ['keepalives', 'PGKEEPALIVES'],
  ['keepalives_count', 'PGKEEPALIVESCOUNT'],
  ['keepalives_idle', 'PGKEEPALIVESIDLE'],
  ['keepalives_interval', 'PGKEEPALIVESINTERVAL'],
  ['krbsrvname', 'PGKRBSRVNAME'],
  ['options', 'PGOPTIONS'],
  ['require_auth', 'PGREQUIREAUTH'],
  ['requirepeer', 'PGREQUIREPEER'],
  ['sslcert', 'PGSSLCERT'],
  ['sslcrl', 'PGSSLCRL'],
  ['sslcrldir', 'PGSSLCRLDIR'],
  ['sslkey', 'PGSSLKEY'],
  ['sslmode', 'PGSSLMODE'],
  ['sslnegotiation', 'PGSSLNEGOTIATION'],
  ['sslpassword', 'PGSSLPASSWORD'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
])

const CONNECTION_ENV = new Set([
  'PGAPPNAME',
  'PGCHANNELBINDING',
  'PGCONNECT_TIMEOUT',
  'PGDATABASE',
  'PGGSSENCMODE',
  'PGHOST',
  'PGHOSTADDR',
  'PGKEEPALIVES',
  'PGKEEPALIVESCOUNT',
  'PGKEEPALIVESIDLE',
  'PGKEEPALIVESINTERVAL',
  'PGKRBSRVNAME',
  'PGOPTIONS',
  'PGPASSFILE',
  'PGPASSWORD',
  'PGPORT',
  'PGREQUIREAUTH',
  'PGREQUIREPEER',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSSLCERT',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLKEY',
  'PGSSLMODE',
  'PGSSLNEGOTIATION',
  'PGSSLPASSWORD',
  'PGSSLROOTCERT',
  'PGTARGETSESSIONATTRS',
  'PGUSER',
])

function fail(message) {
  process.stderr.write(`psql connection configuration error: ${message}\n`)
  process.exit(2)
}

function decode(component, label) {
  try {
    const decoded = decodeURIComponent(component)
    if (decoded.includes('\0')) fail(`${label} contains an unsupported null byte`)
    return decoded
  } catch {
    fail(`${label} is not valid percent-encoding`)
  }
}

function parseDatabaseUrl(raw) {
  if (!raw) fail('DATABASE_URL is required')

  let url
  try {
    url = new URL(raw)
  } catch {
    fail('DATABASE_URL is not a valid URL')
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('DATABASE_URL must use postgres or postgresql')
  }
  if (url.hash) fail('DATABASE_URL fragments are unsupported')
  if (!url.hostname) fail('DATABASE_URL hostname is required')
  if (!url.username) fail('DATABASE_URL username is required')
  if (!url.pathname || url.pathname === '/') fail('DATABASE_URL database name is required')

  const database = decode(url.pathname.slice(1), 'database name')
  if (!database || database.includes('/')) {
    fail('DATABASE_URL must name exactly one database')
  }

  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  const libpq = {
    PGHOST: hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decode(url.username, 'username'),
    // libpq defaults to "prefer", which can silently downgrade. Local test
    // clusters may be plaintext; every remote migration connection must use
    // TLS even when the URI omitted an explicit sslmode.
    PGSSLMODE:
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
        ? 'prefer'
        : 'require',
  }
  if (url.password) libpq.PGPASSWORD = decode(url.password, 'password')

  const seen = new Set()
  for (const [name, value] of url.searchParams) {
    if (seen.has(name)) fail(`duplicate DATABASE_URL option: ${name}`)
    seen.add(name)
    const envName = QUERY_ENV.get(name)
    if (!envName) fail(`unsupported DATABASE_URL option: ${name}`)
    libpq[envName] = value
  }

  return libpq
}

const childEnv = { ...process.env }
for (const name of CONNECTION_ENV) delete childEnv[name]
Object.assign(childEnv, parseDatabaseUrl(process.env.DATABASE_URL))
delete childEnv.DATABASE_URL

const child = spawn('psql', process.argv.slice(2), {
  env: childEnv,
  stdio: 'inherit',
})

const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const forwarders = new Map()
for (const signal of forwardedSignals) {
  const forward = () => {
    if (!child.killed) child.kill(signal)
  }
  forwarders.set(signal, forward)
  process.on(signal, forward)
}

child.once('error', () => {
  fail('psql could not be started')
})

child.once('exit', (code, signal) => {
  for (const [name, listener] of forwarders) process.off(name, listener)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
