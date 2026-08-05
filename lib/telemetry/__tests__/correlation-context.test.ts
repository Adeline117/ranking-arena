import { installCorrelationIdReader, readCorrelationId } from '../correlation-context'

describe('runtime-neutral correlation context', () => {
  it('returns undefined before a runtime owner is installed', () => {
    expect(readCorrelationId()).toBeUndefined()
  })

  it('reads from the installed owner and restores the previous reader', () => {
    const dispose = installCorrelationIdReader(() => 'reader-cid')

    expect(readCorrelationId()).toBe('reader-cid')
    dispose()
    expect(readCorrelationId()).toBeUndefined()
  })
})
