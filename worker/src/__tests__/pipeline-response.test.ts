import { assertSuccessfulMeilisearchSyncResponse } from '../pipeline-response'

describe('pipeline Meilisearch response contract', () => {
  it.each([
    [{ ok: false }, 'ok:false'],
    [{ ok: true, errors: { '30D': 'partial upload' } }, 'season errors'],
    [{ traders: 0 }, 'missing ok'],
  ])('rejects HTTP 200 fake success with %s (%s)', (body) => {
    expect(() => assertSuccessfulMeilisearchSyncResponse(true, 200, body)).toThrow(
      'unsuccessful payload'
    )
  })

  it('accepts HTTP success only when ok is exactly true and errors are empty', () => {
    expect(() =>
      assertSuccessfulMeilisearchSyncResponse(true, 200, { ok: true, errors: {} })
    ).not.toThrow()
  })
})
