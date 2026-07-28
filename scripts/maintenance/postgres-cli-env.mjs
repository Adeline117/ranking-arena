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
