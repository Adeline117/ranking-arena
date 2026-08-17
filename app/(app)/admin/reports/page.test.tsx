import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'

const mockUseAdminAuth = jest.fn()
const mockReportsTab = jest.fn(({ accessToken }: { accessToken: string | null }) => (
  <div data-testid="reports-tab">{accessToken}</div>
))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../hooks/useAdminAuth', () => ({
  useAdminAuth: () => mockUseAdminAuth(),
}))

jest.mock('../components/ReportsTab', () => ({
  __esModule: true,
  default: (props: { accessToken: string | null }) => mockReportsTab(props),
}))

import AdminReportsPage from './page'

describe('AdminReportsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseAdminAuth.mockReturnValue({
      accessToken: 'current-admin-token',
      isAdmin: true,
      authChecking: false,
    })
  })

  it('renders the shared reports client with the currently authorized access token', () => {
    render(<AdminReportsPage />)

    expect(screen.getByTestId('reports-tab')).toHaveTextContent('current-admin-token')
    expect(mockReportsTab).toHaveBeenCalledWith({ accessToken: 'current-admin-token' })
  })

  it('keeps the authorization shell closed while checking or forbidden', () => {
    mockUseAdminAuth.mockReturnValue({ accessToken: null, isAdmin: false, authChecking: true })
    const view = render(<AdminReportsPage />)

    expect(view.container).toBeEmptyDOMElement()

    mockUseAdminAuth.mockReturnValue({ accessToken: null, isAdmin: false, authChecking: false })
    view.rerender(<AdminReportsPage />)

    expect(screen.getByText('noPermissionAccess')).toBeInTheDocument()
    expect(mockReportsTab).not.toHaveBeenCalled()
  })

  it('delegates all report reads and writes without retaining legacy statuses', () => {
    const source = readFileSync(join(process.cwd(), 'app/(app)/admin/reports/page.tsx'), 'utf8')

    expect(source).not.toContain('/api/admin/reports')
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\b(?:reviewed|actioned)\b/)
    expect(source).toContain('<ReportsTab accessToken={accessToken} />')
  })
})
