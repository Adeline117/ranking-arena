/**
 * 输入消毒工具
 * 使用 sanitize-html（htmlparser2 实现，无 jsdom 依赖）防止 XSS 攻击
 *
 * NOTE: 之前基于 isomorphic-dompurify，但其 jsdom 依赖链在 Vercel
 * serverless 上抛 ERR_REQUIRE_ESM 导致整个 UGC 写入路径 500。
 * sanitize-html 纯 JS 解析器，Node serverless 与浏览器均可运行。
 */

import sanitizeHtmlLib from 'sanitize-html'

// 默认允许的 HTML 标签（用于富文本）
const DEFAULT_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'b',
  'i',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'code',
  'pre',
  'span',
  'div',
]

// 默认允许的属性
const DEFAULT_ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'id']

// 绝对禁止的标签 — 即使调用方显式传入 allowedTags 也会被过滤掉
const FORBIDDEN_TAGS = ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed']

/**
 * 消毒配置选项
 */
interface SanitizeOptions {
  /** 允许的 HTML 标签 */
  allowedTags?: string[]
  /** 允许的属性 */
  allowedAttr?: string[]
  /** 是否允许链接 */
  allowLinks?: boolean
  /** 是否保留换行 */
  preserveNewlines?: boolean
  /** 最大长度 */
  maxLength?: number
  /** 是否移除所有 HTML（纯文本） */
  stripHtml?: boolean
}

/**
 * 消毒 HTML 内容
 * 用于富文本输入
 */
export function sanitizeHtml(dirty: string, options: SanitizeOptions = {}): string {
  if (!dirty) return ''

  const {
    allowedTags = DEFAULT_ALLOWED_TAGS,
    allowedAttr = DEFAULT_ALLOWED_ATTR,
    allowLinks = true,
    maxLength,
  } = options

  // 强制过滤危险标签 + 事件处理器属性（onerror/onclick/...）
  let tags = allowedTags.filter((tag) => !FORBIDDEN_TAGS.includes(tag.toLowerCase()))
  let attrs = allowedAttr.filter((attr) => !/^on/i.test(attr) && attr.toLowerCase() !== 'style')

  // 如果不允许链接，移除 a 标签
  if (!allowLinks) {
    tags = tags.filter((tag) => tag !== 'a')
    attrs = attrs.filter((attr) => attr !== 'href' && attr !== 'target')
  }

  const allowLinkTags = tags.includes('a')

  // 按标签配置允许的属性；<a> 额外保证 href/target/rel 可通过，
  // 以便下方 transformTags 注入的 target/rel 不被属性过滤剥掉
  const allowedAttributes: Record<string, string[]> = { '*': attrs }
  if (allowLinkTags) {
    allowedAttributes.a = Array.from(new Set([...attrs, 'href', 'target', 'rel']))
  }

  let clean = sanitizeHtmlLib(dirty, {
    allowedTags: tags,
    allowedAttributes,
    // 不允许的标签：丢弃标签本身但保留文本内容（与 DOMPurify 行为一致）；
    // script/style 等 nonTextTags 的内容会连同标签一起移除
    disallowedTagsMode: 'discard',
    // 只允许 http/https/ftp/mailto/tel 协议 — javascript:/data:/vbscript: href 会被移除
    // 确保链接在新窗口打开且有 noopener（等价于原 DOMPurify afterSanitizeAttributes hook）
    transformTags: allowLinkTags
      ? {
          a: (tagName, attribs) => ({
            tagName,
            attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
          }),
        }
      : undefined,
  })

  // 限制长度
  if (maxLength && clean.length > maxLength) {
    clean = clean.slice(0, maxLength)
  }

  return clean
}

/**
 * 移除所有 HTML 标签，只保留文本内容
 * sanitize-html 会对输出文本做实体编码（& → &amp;），与原 DOMPurify 序列化一致，
 * 调用方在此之后统一做一次实体解码
 */
function stripAllHtml(dirty: string): string {
  return sanitizeHtmlLib(dirty, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  })
}

/**
 * 消毒纯文本
 * 移除所有 HTML 标签，只保留文本内容
 */
export function sanitizeText(dirty: string, options: SanitizeOptions = {}): string {
  if (!dirty) return ''

  const { preserveNewlines = false, maxLength } = options

  // 移除所有 HTML
  let clean = stripAllHtml(dirty)

  // 解码 HTML 实体
  clean = decodeHtmlEntities(clean)

  // 处理换行
  if (!preserveNewlines) {
    clean = clean.replace(/\s+/g, ' ').trim()
  } else {
    // 保留单个换行，合并多个换行
    clean = clean.replace(/\n{3,}/g, '\n\n').trim()
  }

  // 限制长度
  if (maxLength && clean.length > maxLength) {
    clean = clean.slice(0, maxLength)
  }

  return clean
}

/**
 * 消毒用户输入
 * 用于表单输入（用户名、标题等）
 */
export function sanitizeInput(dirty: string, options: SanitizeOptions = {}): string {
  if (!dirty) return ''

  const { maxLength } = options

  // 移除所有 HTML 标签
  let clean = stripAllHtml(dirty)

  // 解码 HTML 实体
  clean = decodeHtmlEntities(clean)

  // 移除控制字符
  clean = clean.replace(/[\x00-\x1F\x7F]/g, '')

  // 规范化空白字符
  clean = clean.replace(/\s+/g, ' ').trim()

  // 限制长度
  if (maxLength && clean.length > maxLength) {
    clean = clean.slice(0, maxLength)
  }

  return clean
}

/**
 * 消毒 URL
 */
export function sanitizeUrl(dirty: string): string {
  if (!dirty) return ''

  const clean = dirty.trim()

  // 检查协议
  try {
    const url = new URL(clean)

    // 只允许 http 和 https 协议
    if (!['http:', 'https:'].includes(url.protocol)) {
      return ''
    }

    return url.toString()
  } catch (_err) {
    /* invalid URL format */
    return ''
  }
}

/**
 * 消毒邮箱地址
 */
export function sanitizeEmail(dirty: string): string {
  if (!dirty) return ''

  const clean = dirty.trim().toLowerCase()

  // 基本邮箱格式验证
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(clean)) {
    return ''
  }

  return clean
}

/**
 * 消毒文件名
 */
export function sanitizeFilename(dirty: string): string {
  if (!dirty) return ''

  // 移除危险字符
  let clean = dirty
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\.\./g, '')
    .trim()

  // 移除开头的点和空格
  clean = clean.replace(/^[\s.]+/, '')

  // 限制长度
  if (clean.length > 255) {
    const ext = clean.slice(clean.lastIndexOf('.'))
    clean = clean.slice(0, 255 - ext.length) + ext
  }

  return clean
}

/**
 * 消毒 JSON 字符串
 */
export function sanitizeJson(dirty: string): string {
  if (!dirty) return '{}'

  try {
    // 解析并重新序列化，移除潜在的危险内容
    const parsed = JSON.parse(dirty)
    return JSON.stringify(parsed)
  } catch (_err) {
    /* malformed JSON */
    return '{}'
  }
}

/**
 * 解码 HTML 实体
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  }

  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (match) => entities[match] || match)
}

/**
 * 批量消毒对象中的字符串字段
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  fieldOptions?: Record<
    string,
    SanitizeOptions & { type?: 'text' | 'html' | 'input' | 'url' | 'email' }
  >
): T {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      const options = fieldOptions?.[key] || {}
      const type = options.type || 'input'

      switch (type) {
        case 'html':
          result[key] = sanitizeHtml(value, options)
          break
        case 'text':
          result[key] = sanitizeText(value, options)
          break
        case 'url':
          result[key] = sanitizeUrl(value)
          break
        case 'email':
          result[key] = sanitizeEmail(value)
          break
        default:
          result[key] = sanitizeInput(value, options)
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeObject(value as Record<string, unknown>, fieldOptions)
    } else {
      result[key] = value
    }
  }

  return result as T
}

/**
 * 清洗 PostgREST 过滤器值
 * 防止通过 .or() 等方法进行过滤器注入攻击
 * PostgREST 使用逗号分隔过滤条件，点号作为运算符分隔符
 */
export function sanitizePostgrestValue(value: string): string {
  if (!value) return ''
  return value
    .replace(/[,.()\[\]]/g, '') // 移除 PostgREST 元字符
    .replace(/[\\%_]/g, (c) => `\\${c}`) // 转义 LIKE 通配符
    .slice(0, 200) // 限制长度
}

/**
 * 检查字符串是否包含潜在危险内容
 */
export function containsDangerousContent(text: string): boolean {
  if (!text) return false

  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i, // onclick=, onerror=, etc.
    /<iframe/i,
    /<object/i,
    /<embed/i,
    /data:/i,
    /vbscript:/i,
  ]

  return dangerousPatterns.some((pattern) => pattern.test(text))
}
