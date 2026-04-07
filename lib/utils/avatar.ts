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
  const trimmed = displayName.trim()
  if (!trimmed) return '?'
  const firstChar = trimmed[0]
  
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
 * Check if a trader ID looks like a wallet address (EVM 0x... or Solana base58)
 */
export function isWalletAddress(traderId: string): boolean {
  // EVM: 0x followed by 40 hex chars
  if (/^0x[a-fA-F0-9]{40,42}$/i.test(traderId)) return true
  // Solana: 32-44 base58 chars (no 0, O, I, l)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(traderId)) return true
  return false
}

/**
 * Generate a deterministic identicon SVG from any string seed.
 * Replaces external calls to api.dicebear.com/7.x/identicon — produces
 * a visually identical geometric pattern with zero network latency.
 * Returns a data URI (data:image/svg+xml,...) safe for img src / next/image.
 */
export function generateIdenticonSvg(seed: string, size = 64): string {
  // Hash the seed to a 32-bit integer
  let hash = 5381
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i)
    hash = hash | 0 // keep 32-bit signed
  }

  const nextVal = () => {
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) | 0
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) | 0
    hash = (hash ^ (hash >>> 16)) | 0
    return (hash >>> 0) / 0xffffffff // 0..1
  }

  // Two accent colours + a pale background
  const hue1 = Math.floor(nextVal() * 360)
  const hue2 = (hue1 + 120 + Math.floor(nextVal() * 120)) % 360
  const bgHue = (hue1 + 240) % 360

  const c1 = `hsl(${hue1},65%,52%)`
  const c2 = `hsl(${hue2},60%,55%)`
  const bg = `hsl(${bgHue},20%,78%)`

  // 5×5 grid, left half generated then mirrored (like GitHub identicons)
  const GRID = 5
  const cell = size / GRID
  let rects = ''

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < 3; col++) {
      const v = nextVal()
      if (v < 0.45) continue // ~55% filled
      const fill = v < 0.72 ? c1 : c2
      const mirrorCol = GRID - 1 - col
      const x1 = col * cell
      const x2 = mirrorCol * cell
      const y = row * cell
      rects += `<rect x="${x1.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${fill}"/>`
      if (col !== mirrorCol) {
        rects += `<rect x="${x2.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${fill}"/>`
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${rects}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Generate a deterministic SVG blockie (Ethereum-style) for a wallet address.
 * Returns a data URI that can be used as an img src.
 * 8×8 grid, mirrored horizontally for symmetry (like MetaMask blockies).
 */
export function generateBlockieSvg(address: string, size = 64): string {
  // Simple deterministic hash from address
  let seed = 0
  const addr = address.toLowerCase()
  for (let i = 0; i < addr.length; i++) {
    seed = ((seed << 5) - seed + addr.charCodeAt(i)) | 0
  }

  // Generate 3 colors from seed
  const nextSeed = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }

  const hue1 = nextSeed() % 360
  const hue2 = (hue1 + 120 + (nextSeed() % 120)) % 360
  const bgHue = (hue1 + 240) % 360

  const color1 = `hsl(${hue1},65%,50%)`
  const color2 = `hsl(${hue2},65%,55%)`
  const bgColor = `hsl(${bgHue},25%,75%)`

  // Generate 8×8 grid (only left half, mirror for symmetry)
  const grid: number[] = []
  for (let i = 0; i < 32; i++) {
    grid.push(nextSeed() % 3) // 0=bg, 1=color1, 2=color2
  }

  const cellSize = size / 8
  let rects = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const val = grid[y * 4 + x]
      if (val === 0) continue
      const fill = val === 1 ? color1 : color2
      const mirrorX = 7 - x
      rects += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${fill}"/>`
      rects += `<rect x="${mirrorX * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${fill}"/>`
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bgColor}"/>${rects}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * 获取用户头像URL（优先使用真实头像，否则返回null由前端显示首字母）
 */
export function getUserAvatarUrl(
  userId: string,
  avatarUrl: string | null | undefined,
  _name?: string | null
): string | null {
  // 如果有真实头像URL，直接返回
  if (avatarUrl && avatarUrl.trim() !== '') {
    return avatarUrl
  }
  
  // 没有头像返回null，前端Avatar组件会显示首字母+渐变背景
  return null
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
 * Domains that can be loaded directly in the browser without the /api/avatar proxy.
 * These have no CORS/Referrer restrictions for img src, or are self-hosted.
 * Note: dicebear.com and robohash.org are in next.config remotePatterns — no proxy needed.
 * Note: data: URIs (local identicons/blockies) are always direct.
 */
const DIRECT_LOAD_DOMAINS = [
  // Avatar generators — no CORS restrictions
  'api.dicebear.com',
  'robohash.org',
  'i.pravatar.cc',
  'randomuser.me',
  'ui-avatars.com',
  // Our own CDN
  'arenafi.org',
  'cdn.arenafi.org',
  // GitHub / Google user content
  'githubusercontent.com',
  'googleusercontent.com',
  // Supabase storage (user uploaded avatars)
  'supabase.co',
  'supabase.in',
]

/**
 * Exchange CDN domains that require the /api/avatar proxy due to CORS or Referrer restrictions.
 * These are whitelisted in the proxy's allowed domains list.
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
  // HTX (multiple CDN domains)
  'htx.com',
  'huobi.com',
  'hbfile.net',
  'hbimg.com',
  // BingX
  'bingx.com',
  // CoinEx
  'coinex.com',
  // LBank
  'lbkrs.com',
  'lbank.com',
  // Others
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
 * Returns false for data URIs, direct domains (dicebear, etc.), and unknown domains.
 * Returns true only for known exchange CDNs with CORS/Referrer restrictions.
 */
export function needsProxy(url: string | null | undefined): boolean {
  if (!url) return false
  // data: URIs are always inline — never proxy
  if (url.startsWith('data:')) return false
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    // Never proxy direct-load domains
    if (DIRECT_LOAD_DOMAINS.some(domain => hostname.includes(domain))) return false
    return PROXY_REQUIRED_DOMAINS.some(domain => hostname.includes(domain))
  } catch (_err) {
    /* invalid URL format */
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
    const imageCdnDomains = [
      'bgstatic.com', 'bnbstatic.com', 'bycsi.com', 'staticimg.com', 'mocortech.com', 'wexx.one',
      'tylhh.net', 'nftstatic.com', 'bscdnweb.com', 'myqcloud.com',
      'bybit.com', 'okx.com', 'okcoin.com', 'kucoin.com',
      'gateimg.com', 'htx.com', 'huobi.com', 'bingx.com',
      'coinex.com', 'lbkrs.com', 'phemex.com', 'bitmart.com',
      'xt.com', 'pionex.com', 'blofin.com', 'weex.com',
    ]
    if (imageCdnDomains.some(domain => parsed.hostname.includes(domain))) {
      return true
    }

    // 默认情况：如果路径很短或没有扩展名，可能不是图片
    // 但如果路径较长且包含数字/哈希，可能是CDN图片
    if (pathname.length > 20 && /[a-f0-9]{8,}/.test(pathname)) {
      return true
    }

    return false
  } catch (_err) {
    /* invalid URL format */
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

  // 过滤掉明显无效的URL（但保留交易所默认头像如 default-avatar.png）
  if (
    avatarUrl.includes('t.co') ||
    avatarUrl.includes('/banner/') ||
    avatarUrl.includes('placeholder') ||
    avatarUrl.includes('dicebear.com') ||
    avatarUrl.includes('identicon') ||
    avatarUrl.includes('robohash.org')
  ) {
    return null // Reject generated avatars — fall back to gradient + initial letter
  }

  // 如果是已知交易所域名，信任并直接代理（不需要 isLikelyImageUrl 检查）
  if (needsProxy(avatarUrl)) {
    return `/api/avatar?url=${encodeURIComponent(avatarUrl)}`
  }

  // 非交易所域名：检查是否像是有效的图片URL
  if (!isLikelyImageUrl(avatarUrl)) {
    return null
  }

  // Direct-load domains (dicebear, supabase, github, etc.) — serve without proxy
  try {
    const hostname = new URL(avatarUrl).hostname.toLowerCase()
    if (DIRECT_LOAD_DOMAINS.some(domain => hostname.includes(domain))) {
      return avatarUrl
    }
  } catch (_err) {
    /* invalid URL — fall through to proxy */
  }

  // Unknown domains with valid image URLs — proxy for safety (CORS/Referrer)
  return `/api/avatar?url=${encodeURIComponent(avatarUrl)}`
}

