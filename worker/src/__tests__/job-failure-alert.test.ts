import { finalJobFailureAlert } from '../job-failure-alert'

const job = (over: Partial<{ name: string; attemptsMade: number; attempts: number }> = {}) => ({
  name: over.name ?? 'distribute:meilisearch',
  attemptsMade: over.attemptsMade ?? 3,
  opts: { attempts: over.attempts ?? 3 },
  data: {},
})
const published = new Set(['score:compute'])

describe('finalJobFailureAlert', () => {
  it('pages once retries are exhausted', () => {
    expect(finalJobFailureAlert(job(), new Error('meili 503'), published)).toEqual({
      sourceSlug: 'arena-worker:distribute:meilisearch',
      phase: 0,
      tier: 'A',
      message: 'job distribute:meilisearch failed after 3/3 attempts: meili 503',
    })
  })

  it('stays quiet while BullMQ will still retry', () => {
    expect(finalJobFailureAlert(job({ attemptsMade: 2 }), new Error('x'), published)).toBeNull()
  })

  it('does not double-page a publication job that already alerted its refusal', () => {
    expect(
      finalJobFailureAlert(job({ name: 'score:compute' }), new Error('x'), published)
    ).toBeNull()
  })

  it('treats a job without retry options as single-attempt', () => {
    const single = { name: 'other', attemptsMade: 1, opts: {}, data: {} }
    expect(finalJobFailureAlert(single, new Error('boom'), published)?.tier).toBe('A')
  })
})
