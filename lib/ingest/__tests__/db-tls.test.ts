import { X509Certificate } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createSecureContext } from 'tls'
import { BUNDLED_INGEST_CA_CERT, describeIngestTlsFailure, resolveIngestSsl } from '../db'

const REMOTE = 'postgresql://u:p@aws-0-x.pooler.supabase.com:5432/postgres'
const PEM = '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----'
const CWD = '/srv/release'

describe('resolveIngestSsl', () => {
  it('uses no TLS for local URLs, even with a broken CA config', () => {
    const readCa = jest.fn(() => {
      throw new Error('ENOENT')
    })
    for (const url of ['postgresql://u@127.0.0.1:5432/db', 'postgresql://u@localhost/db']) {
      expect(resolveIngestSsl(url, {}, readCa, CWD)).toEqual({ mode: 'none', ssl: undefined })
    }
    expect(readCa).not.toHaveBeenCalled()
  })

  it('verifies against the bundled Supabase CA by default', () => {
    const readCa = jest.fn(() => PEM)
    expect(resolveIngestSsl(REMOTE, {}, readCa, CWD)).toEqual({
      mode: 'verify-ca',
      ssl: { ca: PEM, rejectUnauthorized: true },
      caPath: '/srv/release/worker/certs/supabase-root-ca.crt',
    })
    expect(readCa).toHaveBeenCalledWith('/srv/release/worker/certs/supabase-root-ca.crt')
    // An explicit `true` is the same default, not a different trust store.
    expect(resolveIngestSsl(REMOTE, { INGEST_DATABASE_TLS_VERIFY: 'true' }, readCa, CWD).mode).toBe(
      'verify-ca'
    )
  })

  it('lets INGEST_DATABASE_CA_CERT override the CA path', () => {
    const readCa = jest.fn(() => PEM)
    expect(
      resolveIngestSsl(REMOTE, { INGEST_DATABASE_CA_CERT: ' /etc/ca.pem ' }, readCa, CWD)
    ).toEqual({
      mode: 'verify-ca',
      ssl: { ca: PEM, rejectUnauthorized: true },
      caPath: '/etc/ca.pem',
    })
    expect(readCa).toHaveBeenCalledTimes(1)
    expect(readCa).toHaveBeenCalledWith('/etc/ca.pem')
  })

  it('downgrades only on the explicit INGEST_DATABASE_TLS_VERIFY=false opt-out', () => {
    const readCa = jest.fn(() => PEM)
    expect(resolveIngestSsl(REMOTE, { INGEST_DATABASE_TLS_VERIFY: 'FALSE' }, readCa, CWD)).toEqual({
      mode: 'unverified',
      ssl: { rejectUnauthorized: false },
    })
    expect(readCa).not.toHaveBeenCalled()
    for (const value of ['0', 'no', 'off', 'disable']) {
      expect(() =>
        resolveIngestSsl(REMOTE, { INGEST_DATABASE_TLS_VERIFY: value }, readCa, CWD)
      ).toThrow(/must be unset, "true" or "false"/)
    }
  })

  it('rejects an ambiguous CA + verify=false configuration', () => {
    expect(() =>
      resolveIngestSsl(
        REMOTE,
        { INGEST_DATABASE_CA_CERT: '/etc/ca.pem', INGEST_DATABASE_TLS_VERIFY: 'false' },
        () => PEM,
        CWD
      )
    ).toThrow(/ambiguous/)
  })

  it('fails closed when the bundled or overridden CA file is missing', () => {
    const missing = () => {
      throw new Error('ENOENT: no such file')
    }
    expect(() => resolveIngestSsl(REMOTE, {}, missing, CWD)).toThrow(
      /not readable at \/srv\/release\/worker\/certs\/supabase-root-ca\.crt/
    )
    expect(() =>
      resolveIngestSsl(REMOTE, { INGEST_DATABASE_CA_CERT: '/missing.pem' }, missing, CWD)
    ).toThrow(/not readable at \/missing\.pem/)
    // Real filesystem, wrong cwd: the default must not silently degrade.
    expect(() => resolveIngestSsl(REMOTE, {}, undefined, '/nonexistent-release')).toThrow(
      /refusing to connect/
    )
  })

  it('fails closed when the CA file holds no PEM certificate', () => {
    expect(() => resolveIngestSsl(REMOTE, {}, () => '', CWD)).toThrow(/no PEM certificate/)
  })
})

describe('bundled Supabase root CA', () => {
  const pem = readFileSync(resolve(process.cwd(), BUNDLED_INGEST_CA_CERT), 'utf8')
  const certs = (
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  ).map((block) => new X509Certificate(block))

  it('is exactly the two pinned Supabase root CAs', () => {
    expect(
      certs.map((c) => ({ fp: c.fingerprint256, subject: c.subject, ca: c.ca, to: c.validTo }))
    ).toEqual([
      {
        fp: '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
        subject: 'C=US\nST=Delware\nL=New Castle\nO=Supabase Inc\nCN=Supabase Root 2021 CA',
        ca: true,
        to: 'Apr 26 10:56:53 2031 GMT',
      },
      {
        fp: '5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2',
        subject: 'C=US\nST=Delware\nL=New Castle\nO=Supabase Inc\nCN=Supabase Root 2021 CA',
        ca: true,
        to: 'Sep  1 08:01:25 2035 GMT',
      },
    ])
  })

  it('loads into a Node TLS context through the default resolver', () => {
    const tls = resolveIngestSsl(REMOTE, {})
    expect(tls.mode).toBe('verify-ca')
    expect(() => createSecureContext({ ca: tls.ssl?.ca })).not.toThrow()
  })
})

describe('describeIngestTlsFailure', () => {
  it('explains certificate-verification failures and ignores other errors', () => {
    const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })
    expect(describeIngestTlsFailure(tlsError)).toMatch(/TLS verification FAILED/)
    expect(describeIngestTlsFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      null
    )
    expect(describeIngestTlsFailure('boom')).toBe(null)
  })
})
