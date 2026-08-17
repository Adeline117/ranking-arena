/**
 * 内容渲染和处理工具函数
 * 用于帖子、评论等文本内容的解析和渲染
 */

import { ReactNode, createElement } from 'react'
import { getStickerById, isPureSticker, extractStickerId, STICKER_PATTERN } from '@/lib/stickers'
import { logger } from '@/lib/logger'
import { findMarkdownImageTokens, findRawContentUrlTokens } from '@/lib/posts/markdown-images'
import { findMentionTokens } from '@/lib/posts/mentions'

// Arena 主题色
export const ARENA_PURPLE = 'var(--color-brand)'

// 视频嵌入信息
interface VideoEmbed {
  type: 'youtube' | 'bilibili' | 'direct'
  embedUrl: string
  originalUrl: string
}

// 内容片段类型
interface ContentPart {
  type: 'text' | 'image' | 'link' | 'video'
  content: string
  url?: string
  video?: VideoEmbed
}

/**
 * Remote post images must use a network URL.  URL parsing (instead of a
 * startsWith check) rejects malformed, encoded, protocol-relative, and
 * executable schemes before they ever reach an img src or window.open.
 */
export function isAllowedContentImageUrl(value: string | null | undefined): value is string {
  if (!value) return false

  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 解析视频链接，返回嵌入信息
 * 支持 YouTube、Bilibili 和直接视频URL
 */
export function parseVideoUrl(url: string): VideoEmbed | null {
  // YouTube 链接
  // 格式: https://www.youtube.com/watch?v=VIDEO_ID 或 https://youtu.be/VIDEO_ID
  const youtubeMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  )
  if (youtubeMatch) {
    return {
      type: 'youtube',
      embedUrl: `https://www.youtube.com/embed/${youtubeMatch[1]}`,
      originalUrl: url,
    }
  }

  // Bilibili 链接
  // 格式: https://www.bilibili.com/video/BV1xxxxx 或 https://b23.tv/xxx
  const bilibiliMatch = url.match(
    /bilibili\.com\/video\/(BV[a-zA-Z0-9]+)|bilibili\.com\/video\/av(\d+)|b23\.tv\/([a-zA-Z0-9]+)/
  )
  if (bilibiliMatch) {
    const bvid = bilibiliMatch[1]
    const aid = bilibiliMatch[2]
    const shortId = bilibiliMatch[3]

    if (bvid) {
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?bvid=${bvid}&autoplay=0`,
        originalUrl: url,
      }
    } else if (aid) {
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?aid=${aid}&autoplay=0`,
        originalUrl: url,
      }
    } else if (shortId) {
      // b23.tv 短链接暂不支持直接嵌入
      return null
    }
  }

  // 直接视频链接 (mp4, webm, mov, etc.)
  const directVideoMatch = url.match(/\.(mp4|webm|mov|avi|mkv|m4v|ogg)(\?.*)?$/i)
  if (directVideoMatch) {
    return {
      type: 'direct',
      embedUrl: url,
      originalUrl: url,
    }
  }

  return null
}

/**
 * 解析文本内容，提取图片和链接
 * @param text 原始文本
 * @returns 解析后的内容片段数组
 */
export function parseContent(text: string): ContentPart[] {
  if (!text) return []

  const parts: ContentPart[] = []

  // Keep rendering and the post-media authority on one deliberately small
  // Markdown image grammar. In particular, CR/LF cannot be hidden inside a
  // destination and then stripped by WHATWG URL parsing before an <img> load.
  const imageMatches = findMarkdownImageTokens(text)

  // 处理文本中的链接（包括视频链接）
  function processTextWithLinks(str: string): void {
    let currentIndex = 0
    for (const token of findRawContentUrlTokens(str)) {
      if (token.start > currentIndex) {
        parts.push({ type: 'text', content: str.slice(currentIndex, token.start) })
      }

      const videoEmbed = parseVideoUrl(token.url)
      if (videoEmbed) {
        parts.push({ type: 'video', content: token.url, url: token.url, video: videoEmbed })
      } else {
        parts.push({ type: 'link', content: token.url, url: token.url })
      }
      currentIndex = token.end
    }

    if (currentIndex < str.length) {
      parts.push({ type: 'text', content: str.slice(currentIndex) })
    }
  }

  // 构建内容片段
  let currentIndex = 0
  for (const img of imageMatches) {
    // 图片前的文本
    if (img.start > currentIndex) {
      processTextWithLinks(text.slice(currentIndex, img.start))
    }
    // Only http(s) markdown images become media. Preserve every rejected
    // markdown token verbatim as ordinary text rather than partially linking
    // or silently discarding attacker-controlled content.
    if (isAllowedContentImageUrl(img.url)) {
      parts.push({ type: 'image', content: img.alt, url: img.url })
    } else {
      parts.push({ type: 'text', content: img.raw })
    }
    currentIndex = img.end
  }

  // 最后一个图片后的文本
  if (currentIndex < text.length) {
    processTextWithLinks(text.slice(currentIndex))
  }

  // 如果没有图片，直接处理链接
  if (imageMatches.length === 0 && parts.length === 0) {
    processTextWithLinks(text)
  }

  return parts
}

/**
 * 将内容片段渲染为 React 元素
 * 注意：此函数返回 JSX 元素数组，需要在 React 组件中使用
 * @param parts 内容片段数组
 * @returns React 元素数组
 */
export function renderContentParts(parts: ContentPart[]): ReactNode[] {
  return parts.map((part, index) => {
    if (part.type === 'image') {
      // Defense in depth for callers that construct ContentPart objects
      // directly instead of going through parseContent.
      if (!isAllowedContentImageUrl(part.url)) {
        const markdown = part.url ? `![${part.content}](${part.url})` : part.content
        return createElement('span', { key: index }, markdown)
      }

      // 使用带错误处理的图片容器
      return createElement(
        'span',
        {
          key: index,
          className: 'content-image-wrapper',
          style: {
            display: 'inline-block',
            verticalAlign: 'middle',
            margin: '4px 6px',
            position: 'relative',
          },
        },
        createElement('img', {
          src: part.url,
          alt: part.content || 'image',
          loading: 'lazy',
          decoding: 'async',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            const openedWindow = window.open(part.url, '_blank', 'noopener,noreferrer')
            if (openedWindow) openedWindow.opener = null
          },
          onError: (e: React.SyntheticEvent<HTMLImageElement>) => {
            const img = e.currentTarget
            const wrapper = img.parentElement
            if (wrapper) {
              // Replace with error placeholder using safe DOM API (no innerHTML)
              while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild)
              const errorDiv = document.createElement('div')
              Object.assign(errorDiv.style, {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
                borderRadius: '8px',
                padding: '16px',
                minHeight: '80px',
                minWidth: '120px',
                border: '1px dashed #444',
              })
              const label = document.createElement('span')
              Object.assign(label.style, { fontSize: '11px', color: '#888' })
              label.textContent = '图片加载失败'
              errorDiv.appendChild(label)
              wrapper.appendChild(errorDiv)
            }
          },
          style: {
            maxWidth: '100%',
            maxHeight: 300,
            borderRadius: 8,
            cursor: 'pointer',
            display: 'block',
          },
        })
      )
    }

    // 渲染视频播放器
    if (part.type === 'video' && part.video) {
      // 直接视频URL使用 video 标签
      if (part.video.type === 'direct') {
        return createElement(
          'div',
          {
            key: index,
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
            style: {
              position: 'relative' as const,
              width: '100%',
              maxWidth: 640,
              marginTop: 8,
              marginBottom: 8,
              borderRadius: 8,
              overflow: 'hidden',
              background: 'var(--color-text-primary)',
            },
          },
          createElement('video', {
            src: part.video.embedUrl,
            controls: true,
            preload: 'metadata',
            style: {
              width: '100%',
              maxHeight: 360,
              display: 'block',
            },
            onError: () => {
              logger.error('Video failed to load:', part.video?.originalUrl)
            },
          })
        )
      }

      // YouTube/Bilibili 使用 iframe 嵌入
      return createElement(
        'div',
        {
          key: index,
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          style: {
            position: 'relative' as const,
            width: '100%',
            paddingBottom: '56.25%', // 16:9 比例
            marginTop: 8,
            marginBottom: 8,
            borderRadius: 8,
            overflow: 'hidden',
            background: 'var(--color-text-primary)',
          },
        },
        createElement('iframe', {
          src: part.video.embedUrl,
          style: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            border: 'none',
          },
          allowFullScreen: true,
          allow:
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
          title: part.video.type === 'youtube' ? 'YouTube 视频' : 'Bilibili 视频',
          onError: () => {
            // 视频加载失败时的处理
            logger.error('Video failed to load:', part.video?.originalUrl)
          },
        })
      )
    }

    if (part.type === 'link') {
      return createElement(
        'a',
        {
          key: index,
          href: part.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          style: {
            color: ARENA_PURPLE,
            textDecoration: 'underline',
            wordBreak: 'break-all' as const,
          },
        },
        part.content
      )
    }

    return createElement('span', { key: index }, part.content)
  })
}

/**
 * Render #hashtags as clickable links within text.
 * Returns an array of ReactNodes with hashtag links.
 */
function renderTextWithHashtags(text: string, keyPrefix: string): ReactNode[] {
  // Unicode-aware(与 lib/data/hashtags.ts 提取 regex 同步):\w 是 ASCII-only,
  // 会让 #比特币 等 CJK 标签不被 linkify(2026-07-03 修复)。
  const hashtagRegex = /#([\p{L}\p{N}_]{1,30})/gu
  if (!hashtagRegex.test(text)) {
    return renderTextWithStickers(text, keyPrefix)
  }

  const nodes: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  hashtagRegex.lastIndex = 0
  while ((match = hashtagRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(
        ...renderTextWithStickers(text.slice(lastIdx, match.index), `${keyPrefix}-ht${lastIdx}`)
      )
    }
    const tag = match[1]
    nodes.push(
      createElement(
        'a',
        {
          key: `${keyPrefix}-ht${match.index}`,
          href: `/hashtag/${tag.toLowerCase()}`,
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          style: {
            color: ARENA_PURPLE,
            textDecoration: 'none',
            fontWeight: 600,
          },
        },
        `#${tag}`
      )
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) {
    nodes.push(...renderTextWithStickers(text.slice(lastIdx), `${keyPrefix}-ht${lastIdx}`))
  }
  return nodes
}

/**
 * Linkify #hashtags (CJK-aware) and @mentions in a plain-text string.
 * Standalone helper for renderers that don't run the full renderContentWithLinks
 * pipeline (e.g. the post composer preview) but still need tags/mentions to become
 * clickable — mirrors the routes used by the feed body renderer:
 *   #tag  -> /hashtag/<lowercased tag>
 *   @user -> /u/<handle>
 * Hashtag regex is kept in sync with renderTextWithHashtags +
 * lib/data/hashtags.ts; mention parsing mirrors the canonical profile handle
 * contract and excludes email suffixes.
 */
export function linkifyTagsAndMentions(text: string, keyPrefix = 'lm'): ReactNode[] {
  if (!text) return []
  const tokens: Array<
    | { type: 'hashtag'; start: number; end: number; value: string }
    | { type: 'mention'; start: number; end: number; value: string }
  > = []
  for (const match of text.matchAll(/#([\p{L}\p{N}_]{1,30})/gu)) {
    tokens.push({
      type: 'hashtag',
      start: match.index,
      end: match.index + match[0].length,
      value: match[1],
    })
  }
  for (const mention of findMentionTokens(text)) {
    tokens.push({
      type: 'mention',
      start: mention.start,
      end: mention.end,
      value: mention.handle,
    })
  }
  tokens.sort((left, right) => left.start - right.start || left.end - right.end)

  const nodes: ReactNode[] = []
  let lastIdx = 0
  for (const token of tokens) {
    if (token.start < lastIdx) continue
    if (token.start > lastIdx) nodes.push(text.slice(lastIdx, token.start))
    if (token.type === 'hashtag') {
      nodes.push(
        createElement(
          'a',
          {
            key: `${keyPrefix}-ht${token.start}`,
            href: `/hashtag/${token.value.toLowerCase()}`,
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
            style: { color: ARENA_PURPLE, textDecoration: 'none', fontWeight: 600 },
          },
          `#${token.value}`
        )
      )
    } else {
      nodes.push(
        createElement(
          'a',
          {
            key: `${keyPrefix}-mt${token.start}`,
            href: `/u/${encodeURIComponent(token.value)}`,
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
            style: { color: 'var(--color-brand)', textDecoration: 'none', fontWeight: 600 },
          },
          `@${token.value}`
        )
      )
    }
    lastIdx = token.end
  }
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx))
  }
  return nodes.length > 0 ? nodes : [text]
}

/**
 * Lightweight inline Markdown renderer (no external library).
 * Supports: **bold**, *italic*, `code`, ~~strikethrough~~
 * Pattern from Discourse/Mastodon — inline formatting only, not block-level.
 */
function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Order matters: bold before italic (** before *)
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\~\~(.+?)\~\~)/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(
        createElement(
          'span',
          { key: `${keyPrefix}-md${lastIdx}` },
          text.slice(lastIdx, match.index)
        )
      )
    }

    if (match[1]) {
      // **bold**
      nodes.push(createElement('strong', { key: `${keyPrefix}-b${match.index}` }, match[2]))
    } else if (match[3]) {
      // *italic*
      nodes.push(createElement('em', { key: `${keyPrefix}-i${match.index}` }, match[4]))
    } else if (match[5]) {
      // `code`
      nodes.push(
        createElement(
          'code',
          {
            key: `${keyPrefix}-c${match.index}`,
            style: {
              background: 'var(--color-bg-tertiary)',
              padding: '1px 4px',
              borderRadius: 4,
              fontSize: '0.9em',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
          },
          match[6]
        )
      )
    } else if (match[7]) {
      // ~~strikethrough~~
      nodes.push(
        createElement(
          'del',
          {
            key: `${keyPrefix}-s${match.index}`,
            style: { opacity: 0.6 },
          },
          match[8]
        )
      )
    }

    lastIdx = match.index + match[0].length
  }

  if (lastIdx === 0) return [createElement('span', { key: keyPrefix }, text)]
  if (lastIdx < text.length) {
    nodes.push(createElement('span', { key: `${keyPrefix}-md${lastIdx}` }, text.slice(lastIdx)))
  }
  return nodes
}

/**
 * Render @mention tokens within a plain text string as clickable links.
 */
function renderTextWithMentions(text: string, keyPrefix: string): ReactNode[] {
  const mentions = findMentionTokens(text)
  if (mentions.length === 0) {
    // No mentions — apply inline markdown
    return renderInlineMarkdown(text, keyPrefix)
  }

  const nodes: ReactNode[] = []
  let lastIdx = 0
  for (const mention of mentions) {
    if (mention.start > lastIdx) {
      // Apply inline markdown to text between mentions
      nodes.push(
        ...renderInlineMarkdown(text.slice(lastIdx, mention.start), `${keyPrefix}-mt${lastIdx}`)
      )
    }
    nodes.push(
      createElement(
        'a',
        {
          key: `${keyPrefix}-m${mention.start}`,
          href: `/u/${encodeURIComponent(mention.handle)}`,
          style: { color: 'var(--color-brand)', fontWeight: 600, textDecoration: 'none' },
        },
        `@${mention.handle}`
      )
    )
    lastIdx = mention.end
  }
  if (lastIdx < text.length) {
    nodes.push(...renderInlineMarkdown(text.slice(lastIdx), `${keyPrefix}-mt${lastIdx}`))
  }
  return nodes
}

/**
 * Render inline sticker tokens within a text string.
 * Returns an array of ReactNodes with sticker images replacing [sticker:xxx].
 * Also renders @mentions as clickable links.
 */
function renderTextWithStickers(text: string, keyPrefix: string): ReactNode[] {
  STICKER_PATTERN.lastIndex = 0
  if (!STICKER_PATTERN.test(text)) {
    return renderTextWithMentions(text, keyPrefix)
  }

  const nodes: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  STICKER_PATTERN.lastIndex = 0
  while ((match = STICKER_PATTERN.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(
        ...renderTextWithMentions(text.slice(lastIdx, match.index), `${keyPrefix}-t${lastIdx}`)
      )
    }
    const sticker = getStickerById(match[1])
    if (sticker) {
      nodes.push(
        createElement('img', {
          key: `${keyPrefix}-s${match.index}`,
          src: sticker.path,
          alt: sticker.name_en,
          width: 32,
          height: 32,
          loading: 'lazy',
          style: { display: 'inline-block', verticalAlign: 'middle', objectFit: 'contain' },
        })
      )
    } else {
      nodes.push(createElement('span', { key: `${keyPrefix}-u${match.index}` }, match[0]))
    }
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) {
    nodes.push(...renderTextWithMentions(text.slice(lastIdx), `${keyPrefix}-t${lastIdx}`))
  }
  return nodes
}

/**
 * 渲染带链接和图片的内容
 * 组合 parseContent 和 renderContentParts
 * Also handles [sticker:xxx] patterns
 */
export function renderContentWithLinks(text: string): ReactNode[] | null {
  if (!text) return null

  // Pure sticker - render large
  if (isPureSticker(text)) {
    const id = extractStickerId(text)
    const sticker = id ? getStickerById(id) : null
    if (sticker) {
      return [
        createElement('img', {
          key: 'sticker',
          src: sticker.path,
          alt: sticker.name_en,
          width: 128,
          height: 128,
          loading: 'lazy',
          style: { display: 'block', objectFit: 'contain' },
        }),
      ]
    }
  }

  // Split by fenced code blocks first, then process each segment
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g
  const segments: Array<{ type: 'text' | 'codeblock'; content: string; lang?: string }> = []
  let lastIdx = 0
  let codeMatch: RegExpExecArray | null
  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    if (codeMatch.index > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, codeMatch.index) })
    }
    segments.push({ type: 'codeblock', content: codeMatch[2], lang: codeMatch[1] || undefined })
    lastIdx = codeMatch.index + codeMatch[0].length
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIdx) })
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', content: text })
  }

  const result: ReactNode[] = []
  let keyIdx = 0

  for (const seg of segments) {
    if (seg.type === 'codeblock') {
      result.push(
        createElement(
          'pre',
          {
            key: `cb-${keyIdx++}`,
            style: {
              background: 'var(--color-overlay-medium)',
              border: '1px solid var(--glass-border-light)',
              borderRadius: 8,
              padding: '12px 16px',
              margin: '8px 0',
              overflow: 'auto',
              fontSize: 13,
              lineHeight: 1.5,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              color: 'var(--color-border-primary)',
            },
          },
          createElement('code', null, seg.content)
        )
      )
      continue
    }

    // For text segments, handle inline code then parse normally
    const inlineCodeRegex = /`([^`\n]+)`/g
    const inlineParts: Array<{ type: 'text' | 'inlinecode'; content: string }> = []
    let inlineLastIdx = 0
    let inlineMatch: RegExpExecArray | null
    while ((inlineMatch = inlineCodeRegex.exec(seg.content)) !== null) {
      if (inlineMatch.index > inlineLastIdx) {
        inlineParts.push({
          type: 'text',
          content: seg.content.slice(inlineLastIdx, inlineMatch.index),
        })
      }
      inlineParts.push({ type: 'inlinecode', content: inlineMatch[1] })
      inlineLastIdx = inlineMatch.index + inlineMatch[0].length
    }
    if (inlineLastIdx < seg.content.length) {
      inlineParts.push({ type: 'text', content: seg.content.slice(inlineLastIdx) })
    }
    if (inlineParts.length === 0) {
      inlineParts.push({ type: 'text', content: seg.content })
    }

    for (const ip of inlineParts) {
      if (ip.type === 'inlinecode') {
        result.push(
          createElement(
            'code',
            {
              key: `ic-${keyIdx++}`,
              style: {
                background: 'var(--color-accent-primary-15)',
                border: '1px solid var(--color-accent-primary-20)',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: '0.9em',
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              },
            },
            ip.content
          )
        )
        continue
      }

      const parts = parseContent(ip.content)
      for (const part of parts) {
        if (part.type === 'text') {
          result.push(...renderTextWithHashtags(part.content, `p${keyIdx++}`))
        } else {
          result.push(
            ...renderContentParts([part]).map((node, i) => {
              // Re-key to avoid collisions
              if (node && typeof node === 'object' && 'key' in node) {
                return { ...(node as object), key: `rk-${keyIdx++}-${i}` } as ReactNode
              }
              return node
            })
          )
        }
      }
    }
  }

  return result
}

/**
 * 截断文本
 * @param text 原始文本
 * @param maxLength 最大长度
 * @returns 截断后的文本
 */
export function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

/**
 * 检测文本语言（简单判断）
 * @param text 文本内容
 * @returns 'zh' | 'en' | 'other'
 */
export function detectLanguage(text: string): 'zh' | 'en' | 'other' {
  if (!text) return 'other'

  // 检测中文字符
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0
  // 检测英文字符
  const englishChars = text.match(/[a-zA-Z]/g)?.length || 0

  const total = chineseChars + englishChars
  if (total === 0) return 'other'

  if (chineseChars / total > 0.3) return 'zh'
  if (englishChars / total > 0.5) return 'en'

  return 'other'
}

/**
 * 生成文本摘要
 * @param text 原始文本
 * @param maxLength 最大长度（默认 200）
 * @returns 摘要文本
 */
export function generateSummary(text: string, maxLength: number = 200): string {
  if (!text) return ''

  // 移除 Markdown 图片语法
  const cleanText = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')

  // 移除多余空白
  const normalized = cleanText.replace(/\s+/g, ' ').trim()

  return truncateText(normalized, maxLength)
}

/**
 * True for (masked) email-shaped strings like "lo***@gmail.com" — requires a
 * local part, an @, and a dotted domain, so it won't match "@twitterhandle".
 *
 * Shared anonymity guard for trader activity handles: the activity feed is
 * public/anonymous, so an email-shaped handle must never be surfaced as a display
 * name (leaks the address + would produce a broken /trader/<email> link).
 */
export function isEmailLike(value: string | null | undefined): boolean {
  return !!value && /\S+@\S+\.\S+/.test(value)
}

/**
 * 检测文本是否是中文
 */
export function isChineseText(text: string): boolean {
  if (!text) return false
  const chineseRegex = /[\u4e00-\u9fa5]/g
  const chineseMatches = text.match(chineseRegex)
  const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
  return chineseRatio > 0.1
}
