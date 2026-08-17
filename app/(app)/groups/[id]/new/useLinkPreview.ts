'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LinkPreview } from './types'

function firstLinkPreviewUrl(content: string): string | null {
  const match = content.match(/https?:\/\/[^\s)]+/)
  return match ? match[0] : null
}

function isPreviewPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasPreviewText(value: Record<string, unknown>): boolean {
  return (
    (typeof value.title === 'string' && value.title.length > 0) ||
    (typeof value.description === 'string' && value.description.length > 0)
  )
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  )
}

export interface GroupPostLinkPreviewState {
  linkPreview: LinkPreview | null
  linkPreviewLoading: boolean
  linkPreviewUrlRef: React.MutableRefObject<string | null>
  setLinkPreview: (preview: LinkPreview | null) => void
}

export function useGroupPostLinkPreview(content: string): GroupPostLinkPreviewState {
  const detectedUrl = useMemo(() => firstLinkPreviewUrl(content), [content])
  const [linkPreview, setLinkPreviewState] = useState<LinkPreview | null>(null)
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false)
  const linkPreviewUrlRef = useRef<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const dismissedUrlRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const generation = ++generationRef.current
    currentUrlRef.current = detectedUrl
    abortControllerRef.current = null

    if (!detectedUrl) {
      dismissedUrlRef.current = null
      linkPreviewUrlRef.current = null
      setLinkPreviewState(null)
      setLinkPreviewLoading(false)
      return
    }

    if (dismissedUrlRef.current === detectedUrl) {
      linkPreviewUrlRef.current = 'dismissed'
      setLinkPreviewLoading(false)
      return
    }

    dismissedUrlRef.current = null
    linkPreviewUrlRef.current = detectedUrl
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setLinkPreviewLoading(true)

    const isCurrentRequest = (): boolean =>
      !abortController.signal.aborted &&
      generationRef.current === generation &&
      currentUrlRef.current === detectedUrl

    void fetch(`/api/posts/link-preview?url=${encodeURIComponent(detectedUrl)}`, {
      signal: abortController.signal,
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!isCurrentRequest()) return

        if (isPreviewPayload(data) && hasPreviewText(data)) {
          setLinkPreviewState({
            url: detectedUrl,
            title: typeof data.title === 'string' ? data.title : '',
            description: typeof data.description === 'string' ? data.description : '',
            image: typeof data.image === 'string' ? data.image : '',
          })
        } else {
          setLinkPreviewState(null)
        }
      })
      .catch((error: unknown) => {
        if (isCurrentRequest() && !isAbortError(error)) {
          setLinkPreviewState(null)
        }
      })
      .finally(() => {
        if (!isCurrentRequest()) return
        abortControllerRef.current = null
        setLinkPreviewLoading(false)
      })

    return () => {
      abortController.abort()
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null
      }
    }
  }, [detectedUrl])

  const setLinkPreview = useCallback((preview: LinkPreview | null) => {
    if (preview) {
      setLinkPreviewState(preview)
      return
    }

    const currentUrl = currentUrlRef.current
    if (currentUrl) dismissedUrlRef.current = currentUrl
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    linkPreviewUrlRef.current = currentUrl ? 'dismissed' : null
    setLinkPreviewState(null)
    setLinkPreviewLoading(false)
  }, [])

  return {
    linkPreview,
    linkPreviewLoading,
    linkPreviewUrlRef,
    setLinkPreview,
  }
}
