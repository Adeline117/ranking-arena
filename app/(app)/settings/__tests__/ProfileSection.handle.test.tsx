import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/base', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      ReactModule.createElement('div', props, children),
    Text: ({
      children,
      size: _size,
      weight: _weight,
      color: _color,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      size?: string
      weight?: string
      color?: string
    }) => ReactModule.createElement('span', props, children),
  }
})

jest.mock('@/app/components/ui/Avatar', () => () => null)

jest.mock('../components/shared', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react')
  return {
    SectionCard: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement('section', null, children),
    getInputStyle: () => ({}),
  }
})

import { ProfileSection } from '../components/ProfileSection'

const baseProps = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  handle: 'valid_user',
  setHandle: jest.fn(),
  bio: '',
  setBio: jest.fn(),
  previewUrl: null,
  coverPreviewUrl: null,
  coverUrl: null,
  initialHandle: 'valid_user',
  handleAvailable: null,
  checkingHandle: false,
  touchedHandle: false,
  markTouched: jest.fn(),
  onAvatarChange: jest.fn(),
  onCoverChange: jest.fn(),
  onRemoveCover: jest.fn(),
}

describe('ProfileSection canonical handle behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('normalizes to NFC and truncates before committing input state', () => {
    const setHandle = jest.fn()
    render(<ProfileSection {...baseProps} setHandle={setHandle} />)

    fireEvent.change(screen.getByLabelText('username'), {
      target: { value: `${'界'.repeat(29)}\u306F\u3099tail` },
    })

    expect(setHandle).toHaveBeenCalledWith(`${'界'.repeat(29)}\u3070`)
  })

  it('shows a required error for an emptied touched handle', () => {
    render(<ProfileSection {...baseProps} handle="" touchedHandle initialHandle="legacy.user" />)

    expect(screen.getByText('validationHandleMinLength')).toBeInTheDocument()
  })

  it('does not flag an exactly unchanged safe legacy dotted handle', () => {
    render(
      <ProfileSection
        {...baseProps}
        handle="legacy.user"
        initialHandle="legacy.user"
        touchedHandle
      />
    )

    expect(screen.queryByText('validationHandleInvalidChars')).not.toBeInTheDocument()
  })
})
