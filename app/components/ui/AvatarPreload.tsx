'use client'

import { useEffect, type ReactElement } from 'react'
import { getTraderAvatarUrl } from '@/lib/utils/avatar'

interface AvatarPreloadProps {
  /** List of avatar URLs to preload */
  avatarUrls: (string | null | undefined)[]
  /** Maximum number of avatars to preload (default: 10) */
  maxPreload?: number
}

/**
 * Preloads avatar images for faster first-screen rendering
 * Creates link rel="preload" elements in the document head
 */
export function AvatarPreload({ avatarUrls, maxPreload = 10 }: AvatarPreloadProps): ReactElement | null {
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Filter and transform URLs
    const urlsToPreload = avatarUrls
      .slice(0, maxPreload)
      .map(url => getTraderAvatarUrl(url))
      .filter((url): url is string => !!url)

    // Create preload links
    const links: HTMLLinkElement[] = []

    urlsToPreload.forEach(url => {
      // Check if already preloaded
      const existingLink = document.querySelector(`link[rel="preload"][href="${url}"]`)
      if (existingLink) return

      const link = document.createElement('link')
      link.rel = 'preload'
      link.as = 'image'
      link.href = url
      link.setAttribute('data-avatar-preload', 'true')

      document.head.appendChild(link)
      links.push(link)
    })

    // Cleanup on unmount
    return () => {
      links.forEach(link => {
        if (link.parentNode) {
          link.parentNode.removeChild(link)
        }
      })
    }
  }, [avatarUrls, maxPreload])

  return null
}

/**
 * Hook to preload avatar images
 * Can be used in components that fetch trader data
 */
export function useAvatarPreload(avatarUrls: (string | null | undefined)[], maxPreload = 10): void {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const urlsToPreload = avatarUrls
      .slice(0, maxPreload)
      .map(url => getTraderAvatarUrl(url))
      .filter((url): url is string => !!url)

    // Use Image API to preload
    urlsToPreload.forEach(url => {
      const img = new Image()
      img.src = url
    })
  }, [avatarUrls, maxPreload])
}

export default AvatarPreload
