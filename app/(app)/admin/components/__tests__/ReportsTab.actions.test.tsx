import { render, screen } from '@testing-library/react'
import React from 'react'
import type { ReactNode } from 'react'

const mockUseReports = jest.fn()
const mockShowToast = jest.fn()

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
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
  default: ({ title, children }: { title: string; children: ReactNode }) =>
    React.createElement('section', null, React.createElement('h2', null, title), children),
}))

jest.mock('../../hooks/useReports', () => ({
  useReports: (...args: unknown[]) => mockUseReports(...args),
}))

import ReportsTab from '../ReportsTab'

function pendingReport(id: string, contentType: 'post' | 'comment' | 'message' | 'user') {
  return {
    id,
    reporter_id: 'reporter',
    content_type: contentType,
    content_id: `content-${id}`,
    reason: 'spam',
    description: null,
    images: null,
    status: 'pending',
    resolved_by: null,
    resolved_at: null,
    action_taken: null,
    created_at: '2026-08-17T00:00:00.000Z',
    reporter: { id: 'reporter', handle: 'reporter', avatar_url: null },
    contentPreview: null,
    contentAuthor: null,
  }
}

describe('ReportsTab moderation actions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseReports.mockReturnValue({
      reports: [pendingReport('post-1', 'post'), pendingReport('message-1', 'message')],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      loading: false,
      error: null,
      actionLoading: {},
      loadReports: jest.fn(),
      resolveReport: jest.fn(),
      canResolveReport: (report: { content_type: string; status: string }) =>
        report.status === 'pending' &&
        (report.content_type === 'post' || report.content_type === 'comment'),
    })
  })

  it('shows delete only for post/comment reports but keeps dismiss for message/user reports', () => {
    render(React.createElement(ReportsTab, { accessToken: 'admin-token' }))

    expect(mockUseReports).toHaveBeenCalledWith('admin-token', mockShowToast)
    expect(screen.getAllByRole('button', { name: 'adminDismissReport' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'adminDeleteContent' })).toHaveLength(1)
  })

  it('shows a load failure instead of presenting it as an empty moderation queue', () => {
    mockUseReports.mockReturnValue({
      reports: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      loading: false,
      error: 'adminLoadFailed',
      actionLoading: {},
      loadReports: jest.fn(),
      resolveReport: jest.fn(),
      canResolveReport: jest.fn(),
    })

    render(React.createElement(ReportsTab, { accessToken: 'admin-token' }))

    expect(screen.getByRole('alert')).toHaveTextContent('adminLoadFailed')
    expect(screen.queryByText('adminNoReports')).not.toBeInTheDocument()
  })
})
