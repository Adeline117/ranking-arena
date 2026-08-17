import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ImageUploader, VideoUploader } from './MediaUploader'

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

describe('profile post media upload controls', () => {
  const labels: Record<string, string> = {
    addImage: 'Add image',
    addVideo: 'Add video',
    deleteVideo: 'Delete video',
    imageInsertGuideTitle: 'Guide',
    imageInsertStep1: 'Step one',
    imageInsertStep2: 'Step two',
    imageInsertStep2Suffix: 'suffix',
    imageInsertStep3: 'Step three',
    imageSupport: 'Image support',
    imagesOptional: 'Images',
    uploadingImage: 'Uploading image',
    uploadingProgress: 'Uploading {percent}%',
    videoFormatSupport: 'Video support',
    videoOptional: 'Video',
  }
  const t = (key: string): string => labels[key] ?? key

  it('makes a busy image picker inert at the real input and keyboard entry point', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <ImageUploader
        images={[]}
        uploading
        fileInputRef={inputRef}
        onImageUpload={jest.fn()}
        onRemoveImage={jest.fn()}
        onInsertImage={jest.fn()}
        isImageInContent={jest.fn(() => false)}
        onDragStart={jest.fn()}
        onDragOver={jest.fn()}
        onDragEnd={jest.fn()}
        draggedImageIndex={null}
        t={t}
      />
    )

    expect(inputRef.current).toBeDisabled()
    const picker = screen.getByRole('button', { name: 'Uploading image' })
    expect(picker).toHaveAttribute('aria-disabled', 'true')
    expect(picker).toHaveAttribute('tabindex', '-1')
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(inputClick).not.toHaveBeenCalled()
  })

  it('opens an idle image picker from the keyboard', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <ImageUploader
        images={[]}
        uploading={false}
        fileInputRef={inputRef}
        onImageUpload={jest.fn()}
        onRemoveImage={jest.fn()}
        onInsertImage={jest.fn()}
        isImageInContent={jest.fn(() => false)}
        onDragStart={jest.fn()}
        onDragOver={jest.fn()}
        onDragEnd={jest.fn()}
        draggedImageIndex={null}
        t={t}
      />
    )

    expect(inputRef.current).not.toBeDisabled()
    const picker = screen.getByRole('button', { name: 'Add image' })
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: ' ' })
    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  it('makes a busy video picker inert at the real input and keyboard entry point', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <VideoUploader
        videos={[]}
        videoUploading
        videoUploadProgress={25}
        videoInputRef={inputRef}
        onVideoUpload={jest.fn()}
        onRemoveVideo={jest.fn()}
        t={t}
      />
    )

    expect(inputRef.current).toBeDisabled()
    const picker = screen.getByRole('button', { name: 'Uploading 25%' })
    expect(picker).toHaveAttribute('aria-disabled', 'true')
    expect(picker).toHaveAttribute('tabindex', '-1')
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(inputClick).not.toHaveBeenCalled()
  })

  it('opens an idle video picker from the keyboard', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <VideoUploader
        videos={[]}
        videoUploading={false}
        videoUploadProgress={0}
        videoInputRef={inputRef}
        onVideoUpload={jest.fn()}
        onRemoveVideo={jest.fn()}
        t={t}
      />
    )

    expect(inputRef.current).not.toBeDisabled()
    const picker = screen.getByRole('button', { name: 'Add video' })
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  it('keeps video deletion localized and touch-sized', () => {
    const onRemoveVideo = jest.fn()
    render(
      <VideoUploader
        videos={[
          {
            url: 'https://cdn.example/video.mp4',
            fileName: 'video.mp4',
            fileSize: 1_024,
          },
        ]}
        videoUploading={false}
        videoUploadProgress={0}
        videoInputRef={createRef<HTMLInputElement>()}
        onVideoUpload={jest.fn()}
        onRemoveVideo={onRemoveVideo}
        t={t}
      />
    )

    const remove = screen.getByRole('button', { name: 'Delete video' })
    expect(remove).toHaveAttribute('type', 'button')
    expect(remove).toHaveStyle({
      width: `${tokens.touchTarget.min}px`,
      height: `${tokens.touchTarget.min}px`,
    })
    fireEvent.click(remove)
    expect(onRemoveVideo).toHaveBeenCalledTimes(1)
  })
})
