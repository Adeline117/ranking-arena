import { resolveIngestSsl } from '../db'

const REMOTE = 'postgresql://u:p@aws-0-x.pooler.supabase.com:5432/postgres'

describe('resolveIngestSsl', () => {
  it('uses no TLS for local URLs', () => {
    expect(resolveIngestSsl('postgresql://u@127.0.0.1:5432/db', {})).toEqual({
      mode: 'none',
      ssl: undefined,
    })
  })

  it('keeps the legacy unverified default when nothing is configured (no deploy break)', () => {
    expect(resolveIngestSsl(REMOTE, {})).toEqual({
      mode: 'unverified',
      ssl: { rejectUnauthorized: false },
    })
    expect(resolveIngestSsl(REMOTE, { INGEST_DATABASE_TLS_VERIFY: 'false' }).mode).toBe(
      'unverified'
    )
  })

  it('verifies against a configured CA file', () => {
    const readCa = jest.fn(() => '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----')
    expect(resolveIngestSsl(REMOTE, { INGEST_DATABASE_CA_CERT: '/etc/ca.pem' }, readCa)).toEqual({
      mode: 'verify-ca',
      ssl: {
        ca: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----',
        rejectUnauthorized: true,
      },
    })
    expect(readCa).toHaveBeenCalledWith('/etc/ca.pem')
  })

  it('fails closed when the configured CA cannot be read', () => {
    const readCa = () => {
      throw new Error('ENOENT')
    }
    expect(() =>
      resolveIngestSsl(REMOTE, { INGEST_DATABASE_CA_CERT: '/missing.pem' }, readCa)
    ).toThrow('ENOENT')
  })

  it('verifies against the system store when explicitly requested without a CA', () => {
    expect(resolveIngestSsl(REMOTE, { INGEST_DATABASE_TLS_VERIFY: 'true' })).toEqual({
      mode: 'verify-system',
      ssl: { rejectUnauthorized: true },
    })
  })

  it('rejects an ambiguous CA + verify=false configuration', () => {
    expect(() =>
      resolveIngestSsl(
        REMOTE,
        { INGEST_DATABASE_CA_CERT: '/etc/ca.pem', INGEST_DATABASE_TLS_VERIFY: 'false' },
        () => 'ca'
      )
    ).toThrow(/ambiguous/)
  })
})
