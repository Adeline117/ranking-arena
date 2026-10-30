/** @jest-environment node */

jest.unmock('@/lib/utils/logger')

import { runWithCorrelationId } from '@/lib/api/correlation'
import { Logger } from '@/lib/utils/logger'

describe('correlation-aware logger', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('injects the active request ID without a dynamic server import', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation()
    const logger = new Logger('CorrelationTest')

    runWithCorrelationId('logger-cid', () => logger.warn('inside request'))
    logger.warn('outside request')

    expect(warn.mock.calls[0]?.[0]).toContain('[cid:logger-cid]')
    expect(warn.mock.calls[1]?.[0]).not.toContain('[cid:')
  })
})
