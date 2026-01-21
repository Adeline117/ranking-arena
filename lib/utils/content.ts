/**
 * 内容渲染和处理工具函数
 * 用于帖子、评论等文本内容的解析和渲染
 */

import { ReactNode, createElement } from 'react'

// Arena 主题色
export const ARENA_PURPLE = '#8b6fa8'

// 内容片段类型
interface ContentPart {
  type: 'text' | 'image' | 'link'
  content: string
  url?: string
}

/**
 * 解析文本内容，提取图片和链接
 * @param text 原始文本
 * @returns 解析后的内容片段数组
 */
export function parseContent(text: string): ContentPart[] {
  if (!text) return []
  
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  
  const parts: ContentPart[] = []
  
  // 先找出所有图片
  const imageMatches: { start: number; end: number; alt: string; url: string }[] = []
  let match
  while ((match = imageRegex.exec(text)) !== null) {
    imageMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      url: match[2],
    })
  }
  
  // 处理文本中的链接
  function processTextWithLinks(str: string): void {
    const linkParts = str.split(urlRegex)
    linkParts.forEach((part) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        parts.push({ type: 'link', content: part, url: part })
      } else if (part) {
        parts.push({ type: 'text', content: part })
      }
    })
  }
  
  // 构建内容片段
  let currentIndex = 0
  for (const img of imageMatches) {
    // 图片前的文本
    if (img.start > currentIndex) {
      processTextWithLinks(text.slice(currentIndex, img.start))
    }
    // 图片
    parts.push({ type: 'image', content: img.alt, url: img.url })
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
      // 使用带错误处理的图片容器
      return createElement('span', {
        key: index,
        className: 'content-image-wrapper',
        style: {
          display: 'inline-block',
          verticalAlign: 'middle',
          margin: '4px 6px',
          position: 'relative',
        },
      }, createElement('img', {
        src: part.url,
        alt: part.content || 'image',
        loading: 'lazy',
        decoding: 'async',
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          window.open(part.url, '_blank')
        },
        onError: (e: React.SyntheticEvent<HTMLImageElement>) => {
          const img = e.currentTarget
          const wrapper = img.parentElement
          if (wrapper) {
            // 替换为错误占位符
            wrapper.innerHTML = `
              <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 8px;
                padding: 16px;
                min-height: 80px;
                min-width: 120px;
                border: 1px dashed #444;
              ">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff7c7c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                  <line x1="4" y1="4" x2="20" y2="20"></line>
                </svg>
                <span style="font-size: 11px; color: #888;">图片加载失败</span>
              </div>
            `
          }
        },
        style: {
          maxWidth: '100%',
          maxHeight: 300,
          borderRadius: 8,
          cursor: 'pointer',
          display: 'block',
        },
      }))
    }

    if (part.type === 'link') {
      return createElement('a', {
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
      }, part.content)
    }

    return createElement('span', { key: index }, part.content)
  })
}

/**
 * 渲染带链接和图片的内容
 * 组合 parseContent 和 renderContentParts
 */
export function renderContentWithLinks(text: string): ReactNode[] | null {
  if (!text) return null
  const parts = parseContent(text)
  return renderContentParts(parts)
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

