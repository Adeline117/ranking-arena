'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import type { MediaAttachment } from '../components/types'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { readChatUploadAcknowledgement } from '@/lib/chat/upload-contract'
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
        formData.append('scopeType', 'conversation')
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
          const acknowledgement = readChatUploadAcknowledgement(data, {
            scopeId: conversationId,
            originalName: file.name,
            fileType: file.type,
            fileSize: file.size,
            storageBaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
          })
          if (!acknowledgement) throw new Error('Invalid chat upload acknowledgement')
          const attachment: MediaAttachment = {
            url: acknowledgement.url,
            type: acknowledgement.category,
            fileName: acknowledgement.fileName,
            originalName: acknowledgement.originalName,
            fileSize: acknowledgement.fileSize,
          }
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
