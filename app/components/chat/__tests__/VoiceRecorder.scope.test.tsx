import { fireEvent, render, waitFor } from '@testing-library/react'

const mockOnVoiceRecorded = jest.fn<Promise<void>, [File, number]>()
const mockTrackStop = jest.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import VoiceRecorder from '../VoiceRecorder'

class MockMediaRecorder {
  static isTypeSupported = jest.fn(() => true)
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  start() {
    this.state = 'recording'
    this.ondataavailable?.({
      data: new Blob(['voice'], { type: 'audio/webm' }),
    } as BlobEvent)
  }

  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
}

describe('VoiceRecorder scoped upload handoff', () => {
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  let now = 1_000

  beforeEach(() => {
    jest.clearAllMocks()
    mockOnVoiceRecorded.mockResolvedValue()
    now = 1_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue({
          getTracks: () => [{ stop: mockTrackStop }],
        }),
      },
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalMediaRecorder) {
      Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder)
    } else {
      delete (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
    }
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    } else {
      delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices
    }
  })

  it('hands the recording to the conversation-scoped uploader instead of storage directly', async () => {
    const view = render(<VoiceRecorder onVoiceRecorded={mockOnVoiceRecorded} />)

    fireEvent.click(view.getByTitle('voiceMessage'))
    await waitFor(() => expect(view.getByTitle('stopRecording')).toBeTruthy())
    now = 3_000
    fireEvent.click(view.getByTitle('stopRecording'))

    await waitFor(() => expect(mockOnVoiceRecorded).toHaveBeenCalledTimes(1))
    const [file, duration] = mockOnVoiceRecorded.mock.calls[0]
    expect(file).toBeInstanceOf(File)
    expect(file.name).toMatch(/^voice_3000_[a-z0-9]{6}\.webm$/)
    expect(file.type).toBe('audio/webm')
    expect(duration).toBe(2)
    expect(mockTrackStop).toHaveBeenCalled()
  })

  it('does not hand off a recording after the viewer-scoped component unmounts', async () => {
    const view = render(<VoiceRecorder onVoiceRecorded={mockOnVoiceRecorded} />)

    fireEvent.click(view.getByTitle('voiceMessage'))
    await waitFor(() => expect(view.getByTitle('stopRecording')).toBeTruthy())
    now = 3_000
    view.unmount()

    await Promise.resolve()
    expect(mockOnVoiceRecorded).not.toHaveBeenCalled()
    expect(mockTrackStop).toHaveBeenCalled()
  })

  it('releases a microphone stream granted after the component unmounts', async () => {
    const permission = deferred<MediaStream>()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockReturnValue(permission.promise),
      },
    })
    const view = render(<VoiceRecorder onVoiceRecorded={mockOnVoiceRecorded} />)

    fireEvent.click(view.getByTitle('voiceMessage'))
    view.unmount()
    permission.resolve({
      getTracks: () => [{ stop: mockTrackStop }],
    } as unknown as MediaStream)

    await waitFor(() => expect(mockTrackStop).toHaveBeenCalledTimes(1))
    expect(mockOnVoiceRecorded).not.toHaveBeenCalled()
  })
})
