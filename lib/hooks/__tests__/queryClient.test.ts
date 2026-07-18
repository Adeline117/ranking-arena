import { environmentManager } from '@tanstack/react-query'
import { getQueryClient } from '../queryClient'

describe('getQueryClient', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('isolates QueryClient caches between server renders', () => {
    jest.spyOn(environmentManager, 'isServer').mockReturnValue(true)

    const firstRequest = getQueryClient()
    const secondRequest = getQueryClient()

    expect(secondRequest).not.toBe(firstRequest)
    firstRequest.setQueryData(['private-request-data'], 'first')
    expect(secondRequest.getQueryData(['private-request-data'])).toBeUndefined()
  })

  it('reuses one QueryClient for the browser app lifetime', () => {
    jest.spyOn(environmentManager, 'isServer').mockReturnValue(false)

    expect(getQueryClient()).toBe(getQueryClient())
  })
})
