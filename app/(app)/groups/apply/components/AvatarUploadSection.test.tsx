import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { AvatarUploadSection } from './AvatarUploadSection'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        avatarUploadDesc: 'Avatar description',
        deleteImage: 'Delete image',
        groupAvatar: 'Group avatar',
        orWord: 'or',
        uploadImage: 'Upload image',
        uploadingImage: 'Uploading image',
      })[key] ?? key,
  }),
}))

describe('group application avatar controls', () => {
  it('disables every avatar mutation entry while an upload is active', () => {
    const fileInputRef = createRef<HTMLInputElement>()
    const view = render(
      <AvatarUploadSection
        avatarUrl=""
        setAvatarUrl={jest.fn()}
        uploading
        fileInputRef={fileInputRef}
        onImageUpload={jest.fn()}
      />
    )

    expect(fileInputRef.current).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Uploading image' })).toBeDisabled()
    expect(screen.getByPlaceholderText('https://example.com/avatar.png')).toBeDisabled()
    expect(view.container.querySelector('input[type="file"]')).toBe(fileInputRef.current)
  })

  it('names and touch-sizes avatar removal', () => {
    const setAvatarUrl = jest.fn()
    render(
      <AvatarUploadSection
        avatarUrl="https://cdn.example/avatar.png"
        setAvatarUrl={setAvatarUrl}
        uploading={false}
        fileInputRef={createRef<HTMLInputElement>()}
        onImageUpload={jest.fn()}
      />
    )

    const remove = screen.getByRole('button', { name: 'Delete image' })
    expect(remove).toHaveAttribute('type', 'button')
    expect(remove).toHaveStyle({
      width: `${tokens.touchTarget.min}px`,
      height: `${tokens.touchTarget.min}px`,
    })
    fireEvent.click(remove)
    expect(setAvatarUrl).toHaveBeenCalledWith('')
  })
})
