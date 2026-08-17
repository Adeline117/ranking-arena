'use client'

import { tokens } from '@/lib/design-tokens'

export type PreviewVideo = {
  type: 'youtube' | 'bilibili' | 'direct'
  embedUrl: string
}

export function parseVideoUrl(url: string): PreviewVideo | null {
  const youtubeMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  )
  if (youtubeMatch) {
    return { type: 'youtube', embedUrl: `https://www.youtube.com/embed/${youtubeMatch[1]}` }
  }
  const bilibiliMatch = url.match(
    /bilibili\.com\/video\/(BV[a-zA-Z0-9]+)|bilibili\.com\/video\/av(\d+)/
  )
  if (bilibiliMatch) {
    const bvid = bilibiliMatch[1]
    const aid = bilibiliMatch[2]
    if (bvid)
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?bvid=${bvid}&autoplay=0`,
      }
    if (aid)
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?aid=${aid}&autoplay=0`,
      }
  }
  return null
}

/** Marker uploads may be direct files; raw preview URLs keep their existing link behavior. */
export function parseVideoMarkerUrl(url: string): PreviewVideo | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  } catch {
    return null
  }

  const embeddedVideo = parseVideoUrl(url)
  if (embeddedVideo) return embeddedVideo

  return /\.(mp4|webm|mov|avi|mkv|m4v|ogg)(\?.*)?$/i.test(url)
    ? { type: 'direct', embedUrl: url }
    : null
}

export default function VideoPlayer({ embedUrl, type }: PreviewVideo) {
  if (type === 'direct') {
    return (
      <video
        src={embedUrl}
        controls
        preload="metadata"
        style={{
          width: '100%',
          maxHeight: 360,
          display: 'block',
          margin: '8px 0',
          borderRadius: tokens.radius.md,
          background: tokens.colors.black,
        }}
      />
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        paddingBottom: '56.25%',
        margin: '8px 0',
        borderRadius: tokens.radius.md,
        overflow: 'hidden',
        background: tokens.colors.black,
      }}
    >
      <iframe
        src={embedUrl}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          border: 'none',
        }}
        allowFullScreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        title={type === 'youtube' ? 'YouTube video' : 'Bilibili video'}
      />
    </div>
  )
}
