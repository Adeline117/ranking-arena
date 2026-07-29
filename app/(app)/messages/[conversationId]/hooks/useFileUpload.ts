'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import type { MediaAttachment } from '../components/types'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

interface UseFileUploadOptions {
  userId: string | null
  accessToken: string | null
  conversationId: string
}

type UploadFileOptions = {
  publishPending?: boolean
}

type UploadOperation = {
  controller: AbortController
  conversationId: string
  viewer: SettingsViewerSnapshot
}

function readUploadAcknowledgement(
  value: unknown,
  expected: {
    conversationId: string
    file: File
  }
): MediaAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const acknowledgement = value as Record<string, unknown>
  if (
    typeof acknowledgement.url !== 'string' ||
    !acknowledgement.url ||
    typeof acknowledgement.fileName !== 'string' ||
    !acknowledgement.fileName.startsWith(`${expected.conversationId}/`) ||
    acknowledgement.originalName !== expected.file.name ||
    acknowledgement.fileSize !== expected.file.size ||
    !['image', 'video', 'file'].includes(String(acknowledgement.category))
  ) {
    return null
  }
  return {
    url: acknowledgement.url,
    type: acknowledgement.category as MediaAttachment['type'],
    fileName: acknowledgement.fileName,
    originalName: expected.file.name,
    fileSize: expected.file.size,
  }
}

export function useFileUpload({ userId, accessToken, conversationId }: UseFileUploadOptions) {
  const { showToast } = useToast()
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const optionsRef = useRef({ accessToken, conversationId, userId })
  optionsRef.current = { accessToken, conversationId, userId }
  const mountedRef = useRef(false)
  const operationRef = useRef<UploadOperation | null>(null)
  const [pendingAttachment, setPendingAttachment] = useState<MediaAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const operationIsCurrent = useCallback((operation: UploadOperation): boolean => {
    const current = optionsRef.current
    return (
      mountedRef.current &&
      operationRef.current === operation &&
      current.userId === operation.viewer.userId &&
      current.accessToken === operation.viewer.accessToken &&
      current.conversationId === operation.conversationId &&
      isSettingsViewerCurrent(operation.viewer, authRef.current)
    )
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    operationRef.current?.controller.abort()
    operationRef.current = null
    setPendingAttachment(null)
    setUploading(false)
    setIsDragging(false)
  }, [accessToken, conversationId, userId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const uploadFile = useCallback(
    async (
      file: File,
      { publishPending = true }: UploadFileOptions = {}
    ): Promise<MediaAttachment | null> => {
      if (!userId || !conversationId) return null
      const viewer = captureSettingsViewer(authRef.current)
      if (
        !viewer ||
        viewer.userId !== userId ||
        viewer.accessToken !== accessToken ||
        !isSettingsViewerCurrent(viewer, authRef.current)
      ) {
        return null
      }
      const operation: UploadOperation = {
        controller: new AbortController(),
        conversationId,
        viewer,
      }
      operationRef.current?.controller.abort()
      operationRef.current = operation
      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('conversationId', conversationId)
        const res = await globalThis.fetch('/api/chat/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operation.viewer.accessToken}`,
            ...getCsrfHeaders(),
          },
          body: formData,
          signal: operation.controller.signal,
        })
        const data: unknown = await res.json().catch(() => null)
        if (!operationIsCurrent(operation)) return null
        if (res.ok) {
          const attachment = readUploadAcknowledgement(data, { conversationId, file })
          if (!attachment) throw new Error('Invalid chat upload acknowledgement')
          if (publishPending) setPendingAttachment(attachment)
          return attachment
        } else {
          const error =
            data &&
            typeof data === 'object' &&
            typeof (data as Record<string, unknown>).error === 'string'
              ? ((data as Record<string, unknown>).error as string)
              : t('uploadFailed')
          showToast(error, 'error')
        }
      } catch (error) {
        if (operationIsCurrent(operation) && (error as Error).name !== 'AbortError') {
          showToast(t('uploadFailedRetry'), 'error')
        }
      } finally {
        if (operationRef.current === operation) operationRef.current = null
        if (
          mountedRef.current &&
          optionsRef.current.accessToken === operation.viewer.accessToken &&
          isSettingsViewerCurrent(operation.viewer, authRef.current) &&
          optionsRef.current.conversationId === operation.conversationId
        ) {
          setUploading(false)
        }
      }
      return null
    },
    [accessToken, userId, conversationId, operationIsCurrent, showToast, t]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) await uploadFile(file)
    },
    [uploadFile]
  )

  return {
    pendingAttachment,
    setPendingAttachment,
    uploading,
    isDragging,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    uploadFile,
  }
}
