import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ImageUploader } from './ImageUploader'
import { VideoUploader } from './VideoUploader'

const labels: Record<string, string> = {
  addImage: 'Add image',
  addVideo: 'Add video',
  deleteButton: 'Delete image',
  deleteVideo: 'Delete video',
  imageSupport: 'Image support',
  imagesOptional: 'Images',
  insertToContent: 'Insert image',
  uploadingImage: 'Uploading image',
  uploadingProgress: 'Uploading {percent}%',
  videoFormatSupport: 'Video support',
  videoOptional: 'Video',
}

const t = (key: string): string => labels[key] ?? key

describe('group post media upload controls', () => {
  it('makes a busy image picker inert while keeping preview actions named and touch-sized', () => {
    const inputRef = createRef<HTMLInputElement>()
    const onInsert = jest.fn()
    const onRemove = jest.fn()

    render(
      <ImageUploader
        images={[{ url: 'https://cdn.example/image.png', fileName: 'image.png' }]}
        uploading
        uploadProgress={50}
        fileInputRef={inputRef}
        onUpload={jest.fn()}
        onRemove={onRemove}
        onInsert={onInsert}
        language="en"
        t={t}
      />
    )

    expect(inputRef.current).toBeDisabled()
    const picker = screen.getByRole('button', { name: 'Uploading 50%' })
    expect(picker).toHaveAttribute('aria-disabled', 'true')
    expect(picker).toHaveAttribute('tabindex', '-1')
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(inputClick).not.toHaveBeenCalled()

    const insert = screen.getByRole('button', { name: 'Insert image' })
    const remove = screen.getByRole('button', { name: 'Delete image' })
    expect(insert).toHaveAttribute('type', 'button')
    expect(remove).toHaveAttribute('type', 'button')
    expect(insert).toHaveStyle({
      width: `${tokens.touchTarget.min}px`,
      height: `${tokens.touchTarget.min}px`,
    })
    expect(remove).toHaveStyle({
      width: `${tokens.touchTarget.min}px`,
      height: `${tokens.touchTarget.min}px`,
    })
    fireEvent.click(insert)
    fireEvent.click(remove)
    expect(onInsert).toHaveBeenCalledWith('https://cdn.example/image.png')
    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it('opens an idle image picker from the keyboard', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <ImageUploader
        images={[]}
        uploading={false}
        fileInputRef={inputRef}
        onUpload={jest.fn()}
        onRemove={jest.fn()}
        onInsert={jest.fn()}
        language="en"
        t={t}
      />
    )

    expect(inputRef.current).not.toBeDisabled()
    const picker = screen.getByRole('button', { name: /Add image/ })
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: ' ' })
    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  it('makes a busy video picker inert', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <VideoUploader
        videos={[]}
        videoUploading
        videoUploadProgress={25}
        videoInputRef={inputRef}
        onUpload={jest.fn()}
        onRemove={jest.fn()}
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

  it('keeps video deletion named and touch-sized', () => {
    const onRemove = jest.fn()
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
        onUpload={jest.fn()}
        onRemove={onRemove}
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
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('opens an idle video picker from the keyboard', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(
      <VideoUploader
        videos={[]}
        videoUploading={false}
        videoUploadProgress={0}
        videoInputRef={inputRef}
        onUpload={jest.fn()}
        onRemove={jest.fn()}
        t={t}
      />
    )

    expect(inputRef.current).not.toBeDisabled()
    const picker = screen.getByRole('button', { name: /Add video/ })
    const inputClick = jest.spyOn(inputRef.current as HTMLInputElement, 'click')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(inputClick).toHaveBeenCalledTimes(1)
  })
})
