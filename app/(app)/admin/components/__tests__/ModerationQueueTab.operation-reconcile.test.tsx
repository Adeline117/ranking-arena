import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockGetCsrfHeaders = jest.fn(() => ({ 'X-CSRF-Token': 'csrf-token' }))
const mockLoggerError = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      children,
      color: _color,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      color?: string
      size?: string
      weight?: string
    }) => React.createElement('span', props, children),
    Button: ({
      children,
      loading: _loading,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      loading?: boolean
      size?: string
      variant?: string
    }) => React.createElement('button', props, children),
  }
})

jest.mock('@/app/components/ui/Card', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))

import ModerationQueueTab from '../ModerationQueueTab'

const mockFetch = jest.fn()
const CONTENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'
const OPERATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function queueResponse(preview: string, reportId: string, contentId = CONTENT_ID): Response {
  return response({
    success: true,
    data: {
      total: 1,
      items: [
        {
          content_type: 'post',
          content_id: contentId,
          content_preview: preview,
          content_title: null,
          author_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          author_handle: 'target',
          report_count: 1,
          reports: [
            {
              id: reportId,
              reporter_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              reason: 'spam',
              description: null,
              created_at: '2026-07-16T10:00:00.000Z',
              reporter_handle: 'reporter',
            },
          ],
        },
      ],
    },
  })
}

function emptyQueueResponse(): Response {
  return response({ success: true, data: { total: 0, items: [] } })
}

function moderationAck(overrides: Record<string, unknown> = {}): Response {
  return response({
    success: true,
    data: {
      message: "Action 'approve' completed",
      result: {
        action_taken: 'approved_content',
        applied: true,
        author_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        content_affected_count: 0,
        content_soft_deleted: false,
        report_count: 1,
        report_status: 'dismissed',
        result_action: 'approve',
        result_content_id: CONTENT_ID,
        result_content_type: 'post',
        result_operation_id: OPERATION_ID,
        strike_id: null,
        strike_type: null,
        ...overrides,
      },
    },
    meta: { timestamp: '2026-07-16T10:00:00.000Z' },
  })
}

describe('ModerationQueueTab operation replay reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
    jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(OPERATION_ID)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('restores a newer pending target after a lost response and same-operation replay', async () => {
    mockFetch
      .mockResolvedValueOnce(
        queueResponse('old committed batch', '30000000-0000-4000-8000-000000000001')
      )
      // The server committed, but the response was lost before an ACK parsed.
      .mockRejectedValueOnce(new TypeError('network response lost'))
      // A retry reuses the operation ID and receives the durable original ACK.
      .mockResolvedValueOnce(moderationAck())
      // A later pending batch for the same target must win reconciliation.
      .mockResolvedValueOnce(
        queueResponse('new pending batch', '30000000-0000-4000-8000-000000000002')
      )

    render(<ModerationQueueTab accessToken="admin-token" />)

    const approve = await screen.findByRole('button', { name: 'Approve (Dismiss)' })
    fireEvent.click(approve)
    await waitFor(() => expect(approve).toBeEnabled())

    fireEvent.click(approve)
    expect(await screen.findByText('new pending batch')).toBeInTheDocument()

    expect(mockFetch).toHaveBeenCalledTimes(4)
    const firstIntent = JSON.parse(String(mockFetch.mock.calls[1][1]?.body))
    const replayIntent = JSON.parse(String(mockFetch.mock.calls[2][1]?.body))
    expect(firstIntent.operation_id).toBe(OPERATION_ID)
    expect(replayIntent.operation_id).toBe(OPERATION_ID)
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[3][0]).toBe('/api/admin/moderation-queue?page=1&limit=20')
    expect(screen.queryByText('loading')).not.toBeInTheDocument()
  })

  it.each([
    ['a parseable but incomplete success envelope', response({ success: true })],
    [
      'an acknowledgement bound to another operation',
      moderationAck({
        result_operation_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ],
  ])('retains the operation ID after %s', async (_label, malformedAck) => {
    mockFetch
      .mockResolvedValueOnce(
        queueResponse('retryable target', '30000000-0000-4000-8000-000000000003')
      )
      .mockResolvedValueOnce(malformedAck)
      .mockResolvedValueOnce(moderationAck())
      .mockResolvedValueOnce(emptyQueueResponse())

    render(<ModerationQueueTab accessToken="admin-token" />)

    const approve = await screen.findByRole('button', { name: 'Approve (Dismiss)' })
    fireEvent.click(approve)
    await waitFor(() => expect(approve).toBeEnabled())
    expect(screen.getByText('retryable target')).toBeInTheDocument()

    fireEvent.click(approve)
    expect(await screen.findByText('No items pending moderation')).toBeInTheDocument()

    const firstIntent = JSON.parse(String(mockFetch.mock.calls[1][1]?.body))
    const retryIntent = JSON.parse(String(mockFetch.mock.calls[2][1]?.body))
    expect(firstIntent.operation_id).toBe(OPERATION_ID)
    expect(retryIntent.operation_id).toBe(OPERATION_ID)
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('canonicalizes an uppercase queue UUID for the request and bound acknowledgement', async () => {
    mockFetch
      .mockResolvedValueOnce(
        queueResponse(
          'uppercase target',
          '30000000-0000-4000-8000-000000000004',
          CONTENT_ID.toUpperCase()
        )
      )
      .mockResolvedValueOnce(moderationAck())
      .mockResolvedValueOnce(emptyQueueResponse())

    render(<ModerationQueueTab accessToken="admin-token" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve (Dismiss)' }))
    expect(await screen.findByText('No items pending moderation')).toBeInTheDocument()

    const requestBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body))
    expect(requestBody.content_id).toBe(CONTENT_ID)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})
