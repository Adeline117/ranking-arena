import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ImageUploader } from './MediaUploader'

const image = { url: 'https://cdn.example/image.png', fileName: 'image.png' }

function renderImageUploader(
  labels: Record<string, string>,
  options: { inContent?: boolean } = {}
) {
  const onInsertImage = jest.fn()
  const onRemoveImage = jest.fn()

  render(
    <ImageUploader
      images={[image]}
      uploading={false}
      fileInputRef={createRef<HTMLInputElement>()}
      onImageUpload={jest.fn()}
      onRemoveImage={onRemoveImage}
      onInsertImage={onInsertImage}
      isImageInContent={() => options.inContent ?? false}
      onDragStart={jest.fn()}
      onDragOver={jest.fn()}
      onDragEnd={jest.fn()}
      draggedImageIndex={null}
      t={(key) => labels[key] ?? key}
    />
  )

  return { onInsertImage, onRemoveImage }
}

describe('profile post image preview actions', () => {
  it.each([
    {
      locale: 'Chinese',
      insertAtCursor: '插入到光标位置',
      deleteLabel: '删除图片',
    },
    {
      locale: 'Japanese',
      insertAtCursor: 'カーソル位置に画像を挿入',
      deleteLabel: '画像を削除する',
    },
  ])(
    'keeps the $locale controls localized, focus-safe, and touch-sized',
    ({ insertAtCursor, deleteLabel }) => {
      const handlers = renderImageUploader({ insertAtCursor, delete: deleteLabel })
      const insertButton = screen.getByRole('button', { name: insertAtCursor })
      const deleteButton = screen.getByRole('button', { name: deleteLabel })
      const actionStrip = insertButton.parentElement

      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
      expect(insertButton).toHaveAttribute('type', 'button')
      expect(deleteButton).toHaveAttribute('type', 'button')
      expect(insertButton).toHaveStyle({
        width: `${tokens.touchTarget.min}px`,
        height: `${tokens.touchTarget.min}px`,
      })
      expect(deleteButton).toHaveStyle({
        width: `${tokens.touchTarget.min}px`,
        height: `${tokens.touchTarget.min}px`,
      })
      expect(actionStrip).toHaveStyle({ top: '4px', right: '4px' })

      const focusRingClearance =
        Number.parseFloat(tokens.focusRing.width) + Number.parseFloat(tokens.focusRing.offset)
      expect(Number.parseFloat(actionStrip?.style.top ?? '0')).toBeGreaterThanOrEqual(
        focusRingClearance
      )
      expect(Number.parseFloat(actionStrip?.style.right ?? '0')).toBeGreaterThanOrEqual(
        focusRingClearance
      )

      fireEvent.click(insertButton)
      fireEvent.click(deleteButton)
      expect(handlers.onInsertImage).toHaveBeenCalledWith(image.url)
      expect(handlers.onRemoveImage).toHaveBeenCalledWith(0)
    }
  )

  it('announces the re-insert action when the image is already in the post', () => {
    renderImageUploader(
      {
        reinsertAtCursor: '光标位置再次插入图片',
        delete: '删除图片',
      },
      { inContent: true }
    )

    expect(screen.getByRole('button', { name: '光标位置再次插入图片' })).toHaveAttribute(
      'title',
      '光标位置再次插入图片'
    )
  })
})
