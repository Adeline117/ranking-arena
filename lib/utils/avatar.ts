/**
 * 头像工具函数
 * 生成基于用户ID的默认头像
 */

import { canonicalizeLocalExchangeLogoPath } from './exchange-logo-path'

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
  const hash2 = userId
    .split('')
    .reverse()
    .reduce((acc, char) => acc + char.charCodeAt(0), 0)

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
  /** Our own Supabase-Storage mirror (no proxy, no 429). Preferred over avatarUrl for traders. */
  avatarMirrorUrl?: string | null
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
  'bitunix.com',
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
    if (DIRECT_LOAD_DOMAINS.some((domain) => hostname.includes(domain))) return false
    return PROXY_REQUIRED_DOMAINS.some((domain) => hostname.includes(domain))
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
    // data: URIs are inline images — not remote URLs to check
    if (url.startsWith('data:')) return false

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
    const nonImageDomains = ['hyperliquid.xyz', 'dydx.exchange', 'kwenta.eth.limo', 'gains.trade']
    if (nonImageDomains.some((domain) => parsed.hostname.includes(domain))) {
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
    if (pagePatterns.some((pattern) => pathname.includes(pattern))) {
      return false
    }

    // 4. 如果URL以常见图片扩展名结尾，认为是图片
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.avif']
    if (imageExtensions.some((ext) => pathname.endsWith(ext))) {
      return true
    }

    // 5. 如果路径包含图片相关的关键词，可能是图片
    const imageKeywords = [
      'image',
      'avatar',
      'photo',
      'img',
      'picture',
      'static',
      'assets',
      'media',
      'upload',
    ]
    if (imageKeywords.some((keyword) => pathname.includes(keyword))) {
      return true
    }

    // 6. 如果是已知的图片CDN域名，认为是图片
    const imageCdnDomains = [
      'bgstatic.com',
      'bnbstatic.com',
      'bycsi.com',
      'staticimg.com',
      'mocortech.com',
      'wexx.one',
      'tylhh.net',
      'nftstatic.com',
      'bscdnweb.com',
      'myqcloud.com',
      'bybit.com',
      'okx.com',
      'okcoin.com',
      'kucoin.com',
      'gateimg.com',
      'htx.com',
      'huobi.com',
      'bingx.com',
      'coinex.com',
      'lbkrs.com',
      'phemex.com',
      'bitmart.com',
      'xt.com',
      'pionex.com',
      'blofin.com',
      'weex.com',
    ]
    if (imageCdnDomains.some((domain) => parsed.hostname.includes(domain))) {
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
  const normalizedAvatarUrl = canonicalizeLocalExchangeLogoPath(avatarUrl.trim())

  // Persisted exchange fallbacks are local assets, not remote avatars. Older
  // rows may still carry stale extensions or the old gateio basename.
  if (normalizedAvatarUrl.startsWith('/icons/exchanges/')) return normalizedAvatarUrl

  // data: URIs (e.g. inline SVG identicons/blockies) — return as-is, never proxy.
  // These are tiny inline images; proxying them creates absurdly long URLs that
  // cause 400 errors from Next.js Image Optimization (_next/image).
  // Callers must use <img> (not next/image) for data: URIs, or set unoptimized.
  if (normalizedAvatarUrl.startsWith('data:')) return normalizedAvatarUrl

  // 过滤掉明显无效的URL（但保留交易所默认头像如 default-avatar.png）
  if (
    normalizedAvatarUrl.includes('t.co') ||
    normalizedAvatarUrl.includes('/banner/') ||
    normalizedAvatarUrl.includes('placeholder') ||
    normalizedAvatarUrl.includes('dicebear.com') ||
    normalizedAvatarUrl.includes('identicon') ||
    normalizedAvatarUrl.includes('robohash.org')
  ) {
    return null // Reject generated avatars — fall back to gradient + initial letter
  }

  // 如果是已知交易所域名，信任并直接代理（不需要 isLikelyImageUrl 检查）
  if (needsProxy(normalizedAvatarUrl)) {
    return `/api/avatar?url=${encodeURIComponent(normalizedAvatarUrl)}`
  }

  // 非交易所域名：检查是否像是有效的图片URL
  if (!isLikelyImageUrl(normalizedAvatarUrl)) {
    return null
  }

  // Direct-load domains (dicebear, supabase, github, etc.) — serve without proxy
  try {
    const hostname = new URL(normalizedAvatarUrl).hostname.toLowerCase()
    if (DIRECT_LOAD_DOMAINS.some((domain) => hostname.includes(domain))) {
      return normalizedAvatarUrl
    }
  } catch (_err) {
    /* invalid URL — fall through to proxy */
  }

  // Unknown domains with valid image URLs — proxy for safety (CORS/Referrer)
  return `/api/avatar?url=${encodeURIComponent(normalizedAvatarUrl)}`
}

/**
 * Serving-layer avatar chain (ARENA_DATA_SPEC v1.2 §1.4).
 *
 * Resolution order:
 *   1. `avatarMirrorUrl` — our own Supabase Storage mirror (`trader-avatars`
 *      public bucket, written by the ingest worker). No CORS/Referrer issues,
 *      CDN-cacheable — use directly.
 *   2. `avatarOriginUrl` — exchange CDN original. Routed through the
 *      `/api/avatar` proxy (CORS/Referrer/SSRF-safe, edge-cached).
 *   3. `null` — caller renders the gradient + initial fallback
 *      (`getAvatarGradient` + `getAvatarInitial`).
 */
export function getTraderAvatarSrc({
  avatarMirrorUrl,
  avatarOriginUrl,
}: {
  avatarMirrorUrl: string | null | undefined
  avatarOriginUrl: string | null | undefined
}): string | null {
  const mirror = avatarMirrorUrl?.trim()
  if (mirror) return canonicalizeLocalExchangeLogoPath(mirror)

  const origin = avatarOriginUrl?.trim()
  if (origin) {
    const normalizedOrigin = canonicalizeLocalExchangeLogoPath(origin)
    // Inline data URIs and already-local paths need no proxy hop.
    if (normalizedOrigin.startsWith('data:') || normalizedOrigin.startsWith('/')) {
      return normalizedOrigin
    }
    return `/api/avatar?url=${encodeURIComponent(normalizedOrigin)}`
  }

  return null
}

/**
 * Render-time guard for the avatar chain: returns true when `src` is already
 * final and must be used as-is in an <img>/<Image> — i.e. it must NOT be
 * re-wrapped in `/api/avatar?url=` (double-proxying breaks the request).
 *
 * Direct srcs: data URIs, rooted local paths (`/api/avatar?...`, `/icons/...`),
 * and our own Supabase Storage host (avatar mirror + user uploads).
 */
export function isDirectAvatarSrc(src: string): boolean {
  if (src.startsWith('data:') || src.startsWith('/')) return true
  try {
    const host = new URL(src).hostname.toLowerCase()
    const ownHost = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://invalid.local'
    ).hostname.toLowerCase()
    return host === ownHost
  } catch (_err) {
    /* invalid URL — let the proxy reject it */
    return false
  }
}

/**
 * Get exchange platform logo URL for traders without a profile avatar.
 * Used by compute-leaderboard as fallback instead of identicon SVGs.
 * Returns an absolute path to the local logo file in /public/icons/exchanges/.
 */
const EXCHANGE_LOGO_MAP: Record<string, string> = {
  binance_futures: '/icons/exchanges/binance.png',
  binance_spot: '/icons/exchanges/binance.png',
  binance_web3: '/icons/exchanges/binance.png',
  bybit: '/icons/exchanges/bybit.png',
  bybit_spot: '/icons/exchanges/bybit.png',
  bitget_futures: '/icons/exchanges/bitget.png',
  okx_futures: '/icons/exchanges/okx.png',
  okx_spot: '/icons/exchanges/okx.png',
  okx_web3: '/icons/exchanges/okx.png',
  mexc: '/icons/exchanges/mexc.png',
  htx_futures: '/icons/exchanges/htx.png',
  kucoin: '/icons/exchanges/kucoin.png',
  coinex: '/icons/exchanges/coinex.png',
  bingx: '/icons/exchanges/bingx.png',
  bingx_spot: '/icons/exchanges/bingx.png',
  hyperliquid: '/icons/exchanges/hyperliquid.png',
  gmx: '/icons/exchanges/gmx.png',
  dydx: '/icons/exchanges/dydx.png',
  jupiter_perps: '/icons/exchanges/jupiter.png',
  aevo: '/icons/exchanges/aevo.png',
  gains: '/icons/exchanges/gains.png',
  bitfinex: '/icons/exchanges/bitfinex.png',
  blofin: '/icons/exchanges/blofin.png',
  xt: '/icons/exchanges/xt.png',
  weex: '/icons/exchanges/weex.png',
  toobit: '/icons/exchanges/toobit.png',
  btcc: '/icons/exchanges/btcc.png',
  bitunix: '/icons/exchanges/bitunix.png',
  etoro: '/icons/exchanges/etoro.png',
  woox: '/icons/exchanges/woox.png',
  polymarket: '/icons/exchanges/polymarket.png',
  copin: '/icons/exchanges/copin.png',
  paradex: '/icons/exchanges/dydx.png',
}

// New-source slug aliases the bare-prefix fallback can't derive:
const LOGO_SLUG_ALIAS: Record<string, string> = {
  gtrade: 'gains',
  hyperliquid: 'hyperliquid',
  binance_web3: 'binance',
  okx_web3: 'okx',
  bitget_bots: 'bitget',
  // serving 名 'gateio' 无下划线,prefix 派生出不存在的 gateio.png(首页
  // 404,UI 走查 2026-07-10);磁盘文件是 gate.png。
  gateio: 'gate',
}

export function getExchangeLogoUrl(source: string): string {
  const mapped = EXCHANGE_LOGO_MAP[source]
  if (mapped) return canonicalizeLocalExchangeLogoPath(mapped)
  const prefix = source.split('_')[0]
  const base = LOGO_SLUG_ALIAS[source] ?? LOGO_SLUG_ALIAS[prefix] ?? prefix
  return canonicalizeLocalExchangeLogoPath(`/icons/exchanges/${base}.png`)
}
