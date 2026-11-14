// libpq reads all of these variables as connection inputs. A maintenance
// command that supplies an explicit URL must remove ambient values first or a
// service file/hostaddr/password can silently redirect or leak the connection.
export const POSTGRES_CONNECTION_ENV_NAMES = Object.freeze([
  'PGAPPNAME',
  'PGCHANNELBINDING',
  'PGCLIENTENCODING',
  'PGCONNECT_TIMEOUT',
  'PGDATABASE',
  'PGDATESTYLE',
  'PGGEQO',
  'PGGSSENCMODE',
  'PGGSSDELEGATION',
  'PGGSSLIB',
  'PGHOST',
  'PGHOSTADDR',
  'PGKEEPALIVES',
  'PGKEEPALIVESCOUNT',
  'PGKEEPALIVESIDLE',
  'PGKEEPALIVESINTERVAL',
  'PGKRBSRVNAME',
  'PGLOADBALANCEHOSTS',
  'PGLOCALEDIR',
  'PGOPTIONS',
  'PGPASSFILE',
  'PGPASSWORD',
  'PGPORT',
  'PGREQUIREAUTH',
  'PGREQUIREPEER',
  'PGREQUIRESSL',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSSLCERT',
  'PGSSLCERTMODE',
  'PGSSLCOMPRESSION',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLKEY',
  'PGSSLMAXPROTOCOLVERSION',
  'PGSSLMINPROTOCOLVERSION',
  'PGSSLMODE',
  'PGSSLNEGOTIATION',
  'PGSSLPASSWORD',
  'PGSSLROOTCERT',
  'PGSSLSNI',
  'PGSYSCONFDIR',
  'PGTARGETSESSIONATTRS',
  'PGTZ',
  'PGUSER',
])

export function cleanPostgresConnectionEnv(env, overrides = {}) {
  const childEnv = { ...env }
  // Clear the documented set and any future libpq-style PG* variable. This is
  // deliberately broader than today's list so a PostgreSQL upgrade cannot add
  // a new ambient connection override that silently bypasses this boundary.
  // Shell startup hooks/functions and POSIX option parsing are removed too:
  // maintenance pipelines must not let parent env mutate pipefail or reinterpret
  // options placed before the explicit database URL.
  for (const name of Object.keys(childEnv)) {
    if (/^PG[A-Z0-9_]*$/.test(name)) delete childEnv[name]
    if (
      name === 'BASH_ENV' ||
      name === 'ENV' ||
      name === 'POSIXLY_CORRECT' ||
      name.startsWith('BASH_FUNC_')
    ) {
      delete childEnv[name]
    }
  }
  return Object.assign(childEnv, overrides)
}

const LIBPQ_QUERY_ENV = new Map([
  ['application_name', 'PGAPPNAME'],
  ['channel_binding', 'PGCHANNELBINDING'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['gssencmode', 'PGGSSENCMODE'],
  ['host', 'PGHOST'],
  ['keepalives', 'PGKEEPALIVES'],
  ['keepalives_count', 'PGKEEPALIVESCOUNT'],
  ['keepalives_idle', 'PGKEEPALIVESIDLE'],
  ['keepalives_interval', 'PGKEEPALIVESINTERVAL'],
  ['options', 'PGOPTIONS'],
  ['require_auth', 'PGREQUIREAUTH'],
  ['sslcert', 'PGSSLCERT'],
  ['sslkey', 'PGSSLKEY'],
  ['sslmode', 'PGSSLMODE'],
  ['sslnegotiation', 'PGSSLNEGOTIATION'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
])

/**
 * Turn a (password-free) PostgreSQL URI into the libpq environment variables
 * that select the same connection.
 *
 * pg_dump, pg_restore and psql expand a connection URI only when it is given
 * as `--dbname`/the positional database argument. A URI placed in PGDATABASE
 * is read as a literal database NAME, so the client silently falls back to
 * the default local socket instead of the intended server. Passing the parts
 * through the environment keeps the URI out of argv and actually connects.
 */
export function libpqEnvFromConnectionUrl(connectionUrl, label = 'database URL') {
  let url
  try {
    url = new URL(connectionUrl)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${label} must use the postgres or postgresql protocol`)
  }
  const decode = (value, part) => {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded.includes('\0')) throw new Error('null byte')
      return decoded
    } catch {
      throw new Error(`${label} has an invalid ${part}`)
    }
  }
  const database = decode(url.pathname.replace(/^\//, ''), 'database name')
  if (!database || database.includes('/')) {
    throw new Error(`${label} must name exactly one database`)
  }
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname

  const libpq = { PGDATABASE: database }
  if (hostname) libpq.PGHOST = hostname
  if (url.port) libpq.PGPORT = url.port
  if (url.username) libpq.PGUSER = decode(url.username, 'username')

  const seen = new Set()
  for (const [name, value] of url.searchParams) {
    if (seen.has(name)) throw new Error(`${label} repeats the option ${name}`)
    seen.add(name)
    const envName = LIBPQ_QUERY_ENV.get(name)
    if (!envName) throw new Error(`${label} has an unsupported option: ${name}`)
    if (value.includes('\0')) throw new Error(`${label} option ${name} contains a null byte`)
    libpq[envName] = value
  }
  return libpq
}
