/**
 * 头像工具函数
 * 生成基于用户ID的默认头像
 */

/**
 * 根据用户ID生成一个确定性的颜色
 */
export function getAvatarColor(userId: string): string {
  // 使用用户ID的哈希值生成颜色
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash)
  }
  
  // 生成HSL颜色（饱和度70-90%，亮度40-60%，确保颜色鲜艳但不太亮）
  const hue = Math.abs(hash) % 360
  const saturation = 70 + (Math.abs(hash) % 20) // 70-90%
  const lightness = 40 + (Math.abs(hash) % 20) // 40-60%
  
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/**
 * 根据用户ID生成一个确定性的背景渐变
 */
export function getAvatarGradient(userId: string): string {
  const hash1 = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const hash2 = userId.split('').reverse().reduce((acc, char) => acc + char.charCodeAt(0), 0)
  
  const hue1 = Math.abs(hash1) % 360
  const hue2 = Math.abs(hash2) % 360
  const saturation = 70 + (Math.abs(hash1) % 20)
  const lightness1 = 40 + (Math.abs(hash1) % 20)
  const lightness2 = 50 + (Math.abs(hash2) % 20)
  
  return `linear-gradient(135deg, hsl(${hue1}, ${saturation}%, ${lightness1}%), hsl(${hue2}, ${saturation}%, ${lightness2}%))`
}

/**
 * 获取用户头像的首字母
 */
export function getAvatarInitial(name: string | null | undefined): string {
  if (!name || name.trim() === '') {
    return '?'
  }
  
  // 如果是邮箱，取@前的部分
  const displayName = name.includes('@') ? name.split('@')[0] : name
  
  // 取第一个字符，如果是中文取第一个字符，如果是英文取第一个字母
  const firstChar = displayName.trim()[0]
  
  // 如果是中文字符，直接返回
  if (/[\u4e00-\u9fa5]/.test(firstChar)) {
    return firstChar
  }
  
  // 如果是英文字母，返回大写
  if (/[a-zA-Z]/.test(firstChar)) {
    return firstChar.toUpperCase()
  }
  
  // 如果是数字或其他字符，返回原字符
  return firstChar
}


/**
 * 将HSL颜色转换为十六进制（不带#）
 */
function hslToHex(hsl: string): string {
  // 解析 HSL 字符串，例如 "hsl(120, 70%, 50%)"
  const match = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/)
  if (!match) return '8b6fa8' // 默认颜色（去掉#）
  
  const h = parseInt(match[1]) / 360
  const s = parseInt(match[2]) / 100
  const l = parseInt(match[3]) / 100
  
  let r, g, b
  
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1/6) return p + (q - p) * 6 * t
      if (t < 1/2) return q
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
      return p
    }
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
  }
  
  const toHex = (c: number) => {
    const hex = Math.round(c * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }
  
  return `${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * 生成默认头像URL（使用第三方服务）
 * 选项1: DiceBear Avatars (免费，无需API key，基于seed生成确定性头像)
 * 选项2: UI Avatars (免费，简单)
 */
export function generateDefaultAvatarUrl(
  userId: string,
  name?: string | null,
  provider: 'dicebear' | 'ui-avatars' = 'dicebear'
): string {
  const displayName = name || userId
  
  if (provider === 'dicebear') {
    // 使用 DiceBear Avatars - 基于用户ID生成确定性头像
    // 使用 initials 风格，seed 确保相同用户ID总是生成相同的头像
    const seed = userId.replace(/-/g, '').substring(0, 20) // 限制长度
    // 将HSL颜色转换为十六进制（去掉#）
    const color = hslToHex(getAvatarColor(userId))
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${color}&fontSize=40`
  } else {
    // 使用 UI Avatars - 简单但功能有限
    const color = hslToHex(getAvatarColor(userId))
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=${color}&color=fff&size=128&bold=true`
  }
}

/**
 * 获取用户头像URL（优先使用真实头像，否则使用默认头像）
 */
export function getUserAvatarUrl(
  userId: string,
  avatarUrl: string | null | undefined,
  name?: string | null
): string | null {
  // 如果有真实头像URL，直接返回
  if (avatarUrl && avatarUrl.trim() !== '') {
    return avatarUrl
  }
  
  // 否则生成默认头像URL
  return generateDefaultAvatarUrl(userId, name, 'dicebear')
}

/**
 * Avatar 组件 Props
 */
export interface AvatarProps {
  userId: string
  name?: string | null
  avatarUrl?: string | null
  size?: number
  className?: string
  style?: React.CSSProperties
  isTrader?: boolean // 是否是 trader，如果是 trader 且没有头像，只显示首字母，不生成头像
}

/**
 * 需要通过代理加载的头像域名列表
 * 这些域名通常有CORS或Referrer限制
 */
const PROXY_REQUIRED_DOMAINS = [
  // Binance
  'bnbstatic.com',
  'tylhh.net',
  'nftstatic.com',
  'bscdnweb.com',
  'myqcloud.com',
  // Bitget
  'bgstatic.com',
  // MEXC
  'mocortech.com',
  // Bybit
  'bybit.com',
  'staticimg.com',
  'bycsi.com',
  // OKX
  'okx.com',
  'okcoin.com',
  // KuCoin
  'kucoin.com',
  // Gate.io
  'gateimg.com',
  'gate.io',
  // HTX
  'htx.com',
  'huobi.com',
  // BingX
  'bingx.com',
  // CoinEx
  'coinex.com',
  // Others
  'lbkrs.com',
  'weex.com',
  'wexx.one',
  'phemex.com',
  'bitmart.com',
  'xt.com',
  'pionex.com',
  'blofin.com',
]

/**
 * 检查URL是否需要通过代理加载
 */
export function needsProxy(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return PROXY_REQUIRED_DOMAINS.some(domain => hostname.includes(domain))
  } catch {
    return false
  }
}

/**
 * 检查URL是否像是有效的图片URL
 */
function isLikelyImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    const hash = parsed.hash

    // 1. 有hash片段的URL通常是SPA页面，不是图片
    if (hash && hash.length > 1) {
      return false
    }

    // 2. 只有域名没有实际路径的URL不是图片
    if (pathname === '/' || pathname === '') {
      return false
    }

    // 3a. 已知的非图片域名（交易平台前端、区块浏览器等）
    const nonImageDomains = [
      'hyperliquid.xyz',
      'dydx.exchange',
      'kwenta.eth.limo',
      'gains.trade',
    ]
    if (nonImageDomains.some(domain => parsed.hostname.includes(domain))) {
      return false
    }

    // 3b. 路径以 /@ 开头通常是用户主页（如 /@0x...、/@username）
    if (pathname.startsWith('/@')) {
      return false
    }

    // 3c. 明显是HTML页面的路径模式
    const pagePatterns = [
      '/detail/',
      '/account/',
      '/actions/',
      '/portfolio/',
      '/trader/',
      '/profile/',
      '/user/',
      '/copytrading/',
      '/copy-trading/',
      '/leaderboard/',
      '/explorer/',
    ]
    if (pagePatterns.some(pattern => pathname.includes(pattern))) {
      return false
    }

    // 4. 如果URL以常见图片扩展名结尾，认为是图片
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.avif']
    if (imageExtensions.some(ext => pathname.endsWith(ext))) {
      return true
    }

    // 5. 如果路径包含图片相关的关键词，可能是图片
    const imageKeywords = ['image', 'avatar', 'photo', 'img', 'picture', 'static', 'assets', 'media', 'upload']
    if (imageKeywords.some(keyword => pathname.includes(keyword))) {
      return true
    }

    // 6. 如果是已知的图片CDN域名，认为是图片
    const imageCdnDomains = ['bgstatic.com', 'bnbstatic.com', 'bycsi.com', 'staticimg.com', 'mocortech.com', 'wexx.one']
    if (imageCdnDomains.some(domain => parsed.hostname.includes(domain))) {
      return true
    }

    // 默认情况：如果路径很短或没有扩展名，可能不是图片
    // 但如果路径较长且包含数字/哈希，可能是CDN图片
    if (pathname.length > 20 && /[a-f0-9]{8,}/.test(pathname)) {
      return true
    }

    return false
  } catch {
    return false
  }
}

/**
 * 获取交易员头像URL（通过代理以解决CORS问题）
 * @param avatarUrl 原始头像URL
 * @returns 代理后的URL或原始URL
 */
export function getTraderAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl || avatarUrl.trim() === '') return null

  // 过滤掉明显无效的URL
  if (
    avatarUrl.includes('t.co') ||
    avatarUrl.includes('/banner/') ||
    avatarUrl.includes('placeholder') ||
    avatarUrl.includes('default')
  ) {
    return null
  }

  // 检查是否像是有效的图片URL
  if (!isLikelyImageUrl(avatarUrl)) {
    return null
  }

  // 如果是需要代理的域名，使用代理API
  if (needsProxy(avatarUrl)) {
    return `/api/avatar?url=${encodeURIComponent(avatarUrl)}`
  }

  // 其他URL直接返回
  return avatarUrl
}

