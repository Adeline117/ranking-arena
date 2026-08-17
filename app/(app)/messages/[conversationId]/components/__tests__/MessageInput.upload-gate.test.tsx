import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { tokens } from '@/lib/design-tokens'
import MessageInput from '../MessageInput'
import type { MediaAttachment, Message } from '../types'

jest.mock('@/app/components/chat/VoiceRecorder', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/Dynamic', () => ({
  DynamicStickerPicker: () => null,
}))

const labels: Record<string, string> = {
  cancel: 'Cancel',
  enterMessage: 'Enter message',
  file: 'File',
  image: 'Image',
  remove: 'Remove',
  reply: 'Reply',
  replyingTo: 'Replying to',
  send: 'Send',
  sendMediaFile: 'Upload file',
  stickersButton: 'Stickers',
  video: 'Video',
}

const t = (key: string): string => labels[key] ?? key

function renderInput(overrides: Partial<ComponentProps<typeof MessageInput>> = {}) {
  const props: ComponentProps<typeof MessageInput> = {
    inputRef: createRef<HTMLTextAreaElement>(),
    language: 'en',
    newMessage: '',
    onFileUpload: jest.fn().mockResolvedValue(null),
    onPreviewOpen: jest.fn(),
    onSend: jest.fn(),
    onVoiceRecorded: jest.fn().mockResolvedValue(undefined),
    pendingAttachment: null,
    sending: false,
    setNewMessage: jest.fn(),
    setPendingAttachment: jest.fn(),
    setShowStickerPicker: jest.fn(),
    showStickerPicker: false,
    t,
    uploading: false,
    ...overrides,
  }
  return { props, view: render(<MessageInput {...props} />) }
}

describe('direct-message upload gate', () => {
  it('closes file, paste, Enter, and send paths while an attachment upload is active', () => {
    const onFileUpload = jest.fn().mockResolvedValue(null)
    const onSend = jest.fn()
    const { view } = renderInput({
      newMessage: 'send after the attachment is ready',
      onFileUpload,
      onSend,
      uploading: true,
    })

    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).toBeDisabled()
    const upload = screen.getByRole('button', { name: 'Upload file' })
    const send = screen.getByRole('button', { name: 'Send' })
    expect(upload).toBeDisabled()
    expect(send).toBeDisabled()
    for (const control of [upload, send]) {
      expect(control).toHaveAttribute('type', 'button')
      expect(control).toHaveStyle({
        width: `${tokens.touchTarget.min}px`,
        height: `${tokens.touchTarget.min}px`,
      })
    }

    fireEvent.keyDown(screen.getByPlaceholderText('Enter message'), { key: 'Enter' })
    fireEvent.paste(screen.getByPlaceholderText('Enter message'), {
      clipboardData: {
        items: [
          {
            getAsFile: () => new File(['image'], 'pasted.png', { type: 'image/png' }),
            type: 'image/png',
          },
        ],
      },
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(onFileUpload).not.toHaveBeenCalled()
  })

  it('localizes and touch-sizes reply and attachment removal controls', () => {
    const setPendingAttachment = jest.fn()
    const onCancelReply = jest.fn()
    const pendingAttachment: MediaAttachment = {
      fileName: 'proof.pdf',
      fileSize: 1_024,
      originalName: 'proof.pdf',
      type: 'file',
      url: 'https://cdn.example/proof.pdf',
    }
    const replyingTo: Message = {
      content: 'Earlier message',
      created_at: '2026-08-17T00:00:00.000Z',
      id: 'message-1',
      read: true,
      receiver_id: 'receiver-1',
      sender_id: 'sender-1',
    }
    renderInput({
      onCancelReply,
      pendingAttachment,
      replyingTo,
      setPendingAttachment,
    })

    const cancelReply = screen.getByRole('button', { name: 'Cancel: Reply' })
    const removeAttachment = screen.getByRole('button', { name: 'Remove: proof.pdf' })
    const sticker = screen.getByRole('button', { name: 'Stickers' })
    for (const control of [cancelReply, removeAttachment, sticker]) {
      expect(control).toHaveAttribute('type', 'button')
      expect(control).toHaveStyle({
        width: `${tokens.touchTarget.min}px`,
        height: `${tokens.touchTarget.min}px`,
      })
    }
    fireEvent.click(cancelReply)
    fireEvent.click(removeAttachment)
    expect(onCancelReply).toHaveBeenCalledTimes(1)
    expect(setPendingAttachment).toHaveBeenCalledWith(null)
  })

  it('keeps the page-level send authority closed if the component path is bypassed', () => {
    const page = readFileSync(
      resolve(process.cwd(), 'app/(app)/messages/[conversationId]/page.tsx'),
      'utf8'
    )
    const start = page.indexOf('const handleSend = async')
    const end = page.indexOf('const handleVoiceRecorded', start)
    const handler = page.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(handler).toContain('if (!hasContent || sending || fileHook.uploading) return')
    expect(handler.indexOf('fileHook.uploading')).toBeLessThan(handler.indexOf('setSending(true)'))
  })
})
