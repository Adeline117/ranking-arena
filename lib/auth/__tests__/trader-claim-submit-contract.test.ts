import { readTraderClaimSubmitAcknowledgement } from '../trader-claim-submit-contract'

const TIMESTAMP = '2026-08-03T12:00:00.000Z'

const expected = {
  traderId: 'account/42',
  source: 'binance',
  viewerId: '11111111-1111-4111-8111-111111111111',
  method: 'api_key' as const,
}

function acknowledgement(
  dataOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    data: {
      claimId: 'claim-1',
      traderId: expected.traderId,
      source: expected.source,
      viewerId: expected.viewerId,
      method: expected.method,
      status: 'reviewing',
      autoApproved: false,
      ...dataOverrides,
    },
    meta: { timestamp: TIMESTAMP },
    ...envelopeOverrides,
  }
}

describe('readTraderClaimSubmitAcknowledgement', () => {
  it('returns the exact identity-bound reviewing receipt', () => {
    expect(readTraderClaimSubmitAcknowledgement(acknowledgement(), expected)).toEqual({
      claimId: 'claim-1',
      traderId: expected.traderId,
      source: expected.source,
      viewerId: expected.viewerId,
      method: 'api_key',
      status: 'reviewing',
      autoApproved: false,
    })
  })

  it.each([
    ['null', null],
    ['an extra envelope field', acknowledgement({}, { privileged: true })],
    [
      'an extra data field',
      { ...acknowledgement(), data: { ...acknowledgement().data, extra: true } },
    ],
    [
      'an extra metadata field',
      { ...acknowledgement(), meta: { timestamp: TIMESTAMP, cached: true } },
    ],
    ['a malformed timestamp', { ...acknowledgement(), meta: { timestamp: 'today' } }],
    ['an empty claim ID', acknowledgement({ claimId: '' })],
    ['another trader', acknowledgement({ traderId: 'account/99' })],
    ['another source', acknowledgement({ source: 'bybit' })],
    ['another viewer', acknowledgement({ viewerId: '22222222-2222-4222-8222-222222222222' })],
    ['another method', acknowledgement({ method: 'signature' })],
    ['an activated status', acknowledgement({ status: 'verified' })],
    ['an auto-approval claim', acknowledgement({ autoApproved: true })],
  ])('rejects %s', (_label, value) => {
    expect(readTraderClaimSubmitAcknowledgement(value, expected)).toBeNull()
  })
})
