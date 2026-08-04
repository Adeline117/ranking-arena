import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
let mockAuthState: { accessToken: string | null; userId: string | null } = {
  accessToken: 'token-a',
  userId: '11111111-1111-4111-8111-111111111111',
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    unoptimized: _unoptimized,
    ...props
  }: React.ComponentProps<'img'> & { fill?: boolean; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} />
  ),
}))

import ReportModal from '../ReportModal'

type FetchResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const fetchMock = jest.fn<Promise<FetchResponse>, Parameters<typeof fetch>>()
const reporterId = '11111111-1111-4111-8111-111111111111'
const otherReporterId = '33333333-3333-4333-8333-333333333333'
const contentId = '22222222-2222-4222-8222-222222222222'
const reportId = '44444444-4444-4444-8444-444444444444'
const evidenceRef = `reports/${reporterId}/0123456789abcdef.png`
const storageBaseUrl = 'https://project.supabase.co'
const previewUrl = `${storageBaseUrl}/storage/v1/object/sign/reports/${reporterId}/0123456789abcdef.png?token=signed-token`
const createdAt = '2026-08-03T12:00:00.000Z'

function response(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function uploadResponse() {
  return response(200, {
    url: previewUrl,
    preview_url: previewUrl,
    evidence_ref: evidenceRef,
  })
}

function reportResponse(extra: Record<string, unknown> = {}) {
  return response(201, {
    success: true,
    data: {
      report: {
        id: reportId,
        reporter_id: reporterId,
        content_type: 'post',
        content_id: contentId,
        reason: 'spam',
        status: 'pending',
        created_at: createdAt,
        evidence_refs: [evidenceRef],
      },
    },
    meta: { timestamp: createdAt },
    ...extra,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function uploadEvidence(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  expect(input).not.toBeNull()
  fireEvent.change(input as HTMLInputElement, {
    target: { files: [new File(['evidence'], 'evidence.png', { type: 'image/png' })] },
  })
  await waitFor(() => expect(screen.getByAltText('Report evidence')).toBeInTheDocument())
}

function completeReportFields() {
  fireEvent.click(screen.getByRole('button', { name: 'reportReasonSpam' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'reportDetailsLabel' }), {
    target: { value: 'This is enough report evidence.' },
  })
}

describe('ReportModal identity-bound operations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = storageBaseUrl
    mockAuthState = { accessToken: 'token-a', userId: reporterId }
    globalThis.fetch = fetchMock as typeof fetch
  })

  it('closes only after an exact report receipt for the current viewer and target', async () => {
    const onClose = jest.fn()
    fetchMock.mockResolvedValueOnce(uploadResponse()).mockResolvedValueOnce(reportResponse())
    const { container } = render(
      <ReportModal
        isOpen
        onClose={onClose}
        contentType="post"
        contentId={contentId}
        accessToken="legacy-prop-token"
      />
    )

    await uploadEvidence(container)
    completeReportFields()
    fireEvent.click(screen.getByRole('button', { name: 'reportSubmit' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(mockShowToast).toHaveBeenCalledWith('reportSubmitted', 'success')
    const submitRequest = fetchMock.mock.calls.find(([input]) => input === '/api/reports')
    expect(submitRequest?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-a' })
  })

  it('rejects an expanded 201 body instead of reporting success', async () => {
    const onClose = jest.fn()
    fetchMock
      .mockResolvedValueOnce(uploadResponse())
      .mockResolvedValueOnce(reportResponse({ unexpected: true }))
    const { container } = render(
      <ReportModal
        isOpen
        onClose={onClose}
        contentType="post"
        contentId={contentId}
        accessToken="legacy-prop-token"
      />
    )

    await uploadEvidence(container)
    completeReportFields()
    fireEvent.click(screen.getByRole('button', { name: 'reportSubmit' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('reportFailed', 'error'))
    expect(onClose).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('reportSubmitted', 'success')
  })

  it('ignores a valid old-viewer receipt after the authenticated account changes', async () => {
    const pendingReport = deferred<FetchResponse>()
    fetchMock
      .mockResolvedValueOnce(uploadResponse())
      .mockImplementationOnce(() => pendingReport.promise)
    const onClose = jest.fn()
    const view = render(
      <ReportModal
        isOpen
        onClose={onClose}
        contentType="post"
        contentId={contentId}
        accessToken="legacy-prop-token"
      />
    )

    await uploadEvidence(view.container)
    completeReportFields()
    fireEvent.click(screen.getByRole('button', { name: 'reportSubmit' }))
    mockAuthState = { accessToken: 'token-b', userId: otherReporterId }
    view.rerender(
      <ReportModal
        isOpen
        onClose={onClose}
        contentType="post"
        contentId={contentId}
        accessToken="legacy-prop-token"
      />
    )

    pendingReport.resolve(reportResponse())
    await act(async () => {
      await pendingReport.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('reportSubmitted', 'success')
  })
})
