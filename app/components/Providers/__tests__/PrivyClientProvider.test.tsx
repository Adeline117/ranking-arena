import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import PrivyClientProvider from '../PrivyClientProvider'
import { publishPrivyBridgeState, usePrivyBridgeStore } from '@/lib/privy/bridge-store'

jest.mock('@/lib/privy/config', () => ({
  PRIVY_APP_ID: 'test-app-id',
  privyConfig: {},
}))

// Fake SDK host: mounts next to the app and publishes a ready state, like the
// real PrivyStateBridge does from inside PrivyProvider.
jest.mock('../PrivyProviderInner', () => {
  function FakePrivyHost() {
    useEffect(() => {
      publishPrivyBridgeState({ ready: true, authenticated: false, user: null, login: () => {} })
    }, [])
    return <div data-testid="privy-host" />
  }
  return { __esModule: true, default: FakePrivyHost }
})

let mountCount = 0

function StatefulChild() {
  const [value, setValue] = useState('')
  useEffect(() => {
    mountCount += 1
  }, [])
  return <input aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />
}

describe('PrivyClientProvider', () => {
  beforeEach(() => {
    mountCount = 0
    usePrivyBridgeStore.setState({ ready: false, authenticated: false, user: null, login: null })
    jest.useFakeTimers()
    delete (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does not remount children when the Privy SDK finishes loading', async () => {
    render(
      <PrivyClientProvider>
        <StatefulChild />
      </PrivyClientProvider>
    )
    const input = screen.getByLabelText('field') as HTMLInputElement
    act(() => {
      input.focus()
    })
    // Simulate the user typing before Privy loads.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'typed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(mountCount).toBe(1)

    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    jest.useRealTimers()
    await waitFor(() => expect(screen.getByTestId('privy-host')).toBeInTheDocument())
    await waitFor(() => expect(usePrivyBridgeStore.getState().ready).toBe(true))

    expect(mountCount).toBe(1)
    expect(screen.getByLabelText('field')).toBe(input)
    expect((screen.getByLabelText('field') as HTMLInputElement).value).toBe('typed')
  })
})
