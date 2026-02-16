'use client'

import { useState, useCallback } from 'react'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import type { MediaAttachment } from '../components/types'

interface UseFileUploadOptions {
  userId: string | null
  conversationId: string
}

export function useFileUpload({ userId, conversationId }: UseFileUploadOptions) {
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [pendingAttachment, setPendingAttachment] = useState<MediaAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && userId && conversationId) {
      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId)
        formData.append('conversationId', conversationId)
        const res = await globalThis.fetch('/api/chat/upload', { method: 'POST', headers: getCsrfHeaders(), body: formData })
        const data = await res.json()
        if (res.ok) {
          setPendingAttachment({ url: data.url, type: data.category, fileName: data.fileName, originalName: data.originalName, fileSize: data.fileSize })
        } else {
          showToast(data.error || t('uploadFailed'), 'error')
        }
      } catch {
        showToast(t('uploadFailedRetry'), 'error')
      } finally {
        setUploading(false)
      }
    }
  }, [userId, conversationId, showToast, t])

  return {
    pendingAttachment, setPendingAttachment,
    uploading, setUploading,
    isDragging,
    handleDragOver, handleDragLeave, handleDrop,
  }
}
