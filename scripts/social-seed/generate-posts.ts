/**
 * Auto-generate natural social posts using KOL style training data + user personas
 *
 * Usage: npx tsx scripts/social-seed/generate-posts.ts [count]
 *
 * Features:
 *   - Persona-driven: each user only posts about their persona's topics
 *   - Reply chains: ~30% of posts get a reply from a contrasting persona
 *   - Prediction polls: prediction_ask posts get poll_enabled + seed votes
 *   - Time distribution across past 7 days with language-aware hours
 *   - Comments: 30%+ reference post content specifically
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

// Load training data and personas
const trainingData = JSON.parse(
  readFileSync(join(__dirname, 'kol-style-training.json'), 'utf-8')
)
const personas: Persona[] = JSON.parse(
  readFileSync(join(__dirname, 'seed-user-personas.json'), 'utf-8')
)

interface Persona {
  handle: string
  persona: string
  language: 'en' | 'zh' | 'both'
  topics: string[]
  never_talks_about: string[]
  tone: string
  preferred_post_types: string[]
}

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const weightedPick = <T>(arr: T[], weights: number[]): T => {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i]
    if (r <= 0) return arr[i]
  }
  return arr[arr.length - 1]
}

interface MarketData {
  btcPrice: number
  ethPrice: number
  solPrice: number
  btc24h: number
  eth24h: number
  sol24h: number
  isVolatile: boolean
}

interface TraderData {
  name: string
  platform: string
  roi: number
  winRate: number
  score: number
}

interface AggregateStats {
  totalTraders: number
  profitPct: number
  topPct: number
  avgWinRate: number
  platformCount: number
  lowestWRWithHighScore: number
}

interface UserRecord {
  id: string
  handle: string
  avatar_url: string | null
}

async function getAggregateStats(): Promise<AggregateStats> {
  const [
    { count: total },
    { count: profitable },
    { count: score80 },
  ] = await Promise.all([
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).gt('pnl', 0),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).gte('arena_score', 80),
  ])
  const totalTraders = total || 39000
  const profitPct = Math.round(((profitable || 0) / totalTraders) * 100)
  const topPct = Math.round(((score80 || 0) / totalTraders) * 100)

  const { data: lowWR } = await supabase
    .from('leaderboard_ranks')
    .select('win_rate')
    .gte('arena_score', 90)
    .order('win_rate', { ascending: true })
    .limit(1)
    .maybeSingle()

  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
  const uniquePlatforms = new Set((platforms || []).map(p => p.source))

  return {
    totalTraders,
    profitPct,
    topPct,
    avgWinRate: randInt(38, 52),
    platformCount: uniquePlatforms.size || 27,
    lowestWRWithHighScore: Math.round(Number(lowWR?.win_rate || 18)),
  }
}

async function getMarketData(): Promise<MarketData> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true'
    )
    const d = await res.json()
    const btc24h = Math.round((d.bitcoin?.usd_24h_change || 0) * 10) / 10
    const eth24h = Math.round((d.ethereum?.usd_24h_change || 0) * 10) / 10
    const sol24h = Math.round((d.solana?.usd_24h_change || 0) * 10) / 10
    const isVolatile = Math.abs(btc24h) > 5 || Math.abs(eth24h) > 5 || Math.abs(sol24h) > 5
    return {
      btcPrice: d.bitcoin?.usd || 73000,
      ethPrice: d.ethereum?.usd || 2200,
      solPrice: d.solana?.usd || 93,
      btc24h, eth24h, sol24h,
      isVolatile,
    }
  } catch {
    return { btcPrice: 73000, ethPrice: 2200, solPrice: 93, btc24h: 0, eth24h: 0, sol24h: 0, isVolatile: false }
  }
}

async function getLeaderboardData(): Promise<TraderData[]> {
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('handle, source, arena_score, roi, win_rate')
    .eq('season_id', 'current')
    .order('arena_score', { ascending: false })
    .limit(30)

  if (!data?.length) {
    const { data: d2 } = await supabase
      .from('leaderboard_ranks')
      .select('handle, source, arena_score, roi, win_rate')
      .order('arena_score', { ascending: false })
      .limit(30)
    return (d2 || []).map(mapTrader)
  }
  return data.map(mapTrader)
}

function mapTrader(t: Record<string, unknown>): TraderData {
  const roi = Number(t.roi ?? 0)
  return {
    name: String(t.handle || 'unknown'),
    platform: String(t.source || 'unknown'),
    roi: Math.round(roi > 10 ? roi : roi * 100),
    winRate: Math.round(Number(t.win_rate ?? 0)),
    score: Math.round(Number(t.arena_score ?? 0)),
  }
}

function formatPrice(price: number): string {
  if (price >= 1000) return Math.round(price / 1000) + 'k'
  return String(Math.round(price))
}

// --- Persona helpers ---

function getPersona(handle: string): Persona | undefined {
  return personas.find(p => p.handle === handle)
}

/** Pick a template category that matches the persona's preferred_post_types */
function pickCategoryForPersona(persona: Persona): string {
  const templates = trainingData.post_templates
  const available = Object.keys(templates).filter(
    cat => persona.preferred_post_types.includes(cat)
  )
  if (available.length === 0) return pick(Object.keys(templates))
  return pick(available)
}

/** Filter templates to match persona language */
function filterTemplatesByLanguage(templates: string[], persona: Persona): string[] {
  if (persona.language === 'both') return templates
  return templates.filter(t => {
    const hasChinese = /[\u4e00-\u9fff]/.test(t)
    if (persona.language === 'zh') return hasChinese
    return !hasChinese
  })
}

/** Find a contrasting persona for reply chains */
function findContrastingPersona(original: Persona, allPersonas: Persona[]): Persona | undefined {
  // Define contrasting pairs
  const contrastMap: Record<string, string[]> = {
    btconly: ['defichad', 'shanzhai', '0xalt'],
    defichad: ['btconly', 'diamondh', 'cexwatcher'],
    'quant_dev': ['suoha', 'levup', 'ta_ren'],
    levup: ['quant_dev', 'yangsheng', 'readntrade'],
    'alpha_sr': ['diamondh', 'shanzhai', 'btconly'],
    diamondh: ['levup', 'boduan', 'alpha_sr'],
    cexwatcher: ['defichad', '0xalt'],
    'onchain_k': ['cexwatcher', 'ta_ren'],
    botrunner: ['ta_ren', 'tradersz', 'jiucai_og'],
    whale88: ['dushu_t', 'shanzhai'],
    jiucai_og: ['whale88', 'quant_dev'],
    suoha: ['yangsheng', 'readntrade', 'quant_dev'],
    baocang: ['diamondh', 'yangsheng'],
    macro_t: ['ta_ren', 'shanzhai'],
    ta_ren: ['macro_t', 'botrunner'],
    shanzhai: ['btconly', 'alpha_sr'],
  }
  const preferred = contrastMap[original.handle] || []
  const candidates = allPersonas.filter(
    p => p.handle !== original.handle && preferred.includes(p.handle)
  )
  if (candidates.length > 0) return pick(candidates)
  // Fallback: any different persona
  const others = allPersonas.filter(p => p.handle !== original.handle)
  return others.length > 0 ? pick(others) : undefined
}

// --- Time distribution ---

interface DaySlot {
  date: Date
  dayOfWeek: number
  isWeekend: boolean
  postCount: number
}

function buildDaySlots(totalPosts: number, isVolatile: boolean): DaySlot[] {
  const now = new Date()
  const slots: DaySlot[] = []
  for (let d = 0; d < 7; d++) {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() - d)
    date.setUTCHours(0, 0, 0, 0)
    const dayOfWeek = date.getUTCDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    slots.push({ date, dayOfWeek, isWeekend, postCount: 0 })
  }

  const baseWeight = 1
  const weights = slots.map(s => {
    let w = s.isWeekend ? baseWeight * 0.6 : baseWeight
    if (s.date.toDateString() === now.toDateString() && isVolatile) w *= 1.5
    return w
  })
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  let remaining = totalPosts
  for (let i = 0; i < slots.length; i++) {
    const share = Math.round((weights[i] / totalWeight) * totalPosts)
    slots[i].postCount = Math.min(share, remaining)
    remaining -= slots[i].postCount
  }
  while (remaining > 0) {
    const idx = randInt(0, slots.length - 1)
    slots[idx].postCount++
    remaining--
  }

  return slots
}

function randomTimeForDay(day: Date, lang: 'zh' | 'en'): Date {
  const ts = new Date(day)
  if (lang === 'zh') {
    const hour = 10 + Math.random() * 6
    ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
  } else {
    const roll = Math.random()
    if (roll < 0.7) {
      const hour = 14 + Math.random() * 10
      ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
    } else {
      const hour = Math.random() * 6
      ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
    }
  }
  if (ts.getTime() > Date.now()) {
    ts.setTime(Date.now() - randInt(60, 3600) * 1000)
  }
  return ts
}

// --- Post generation ---

function generatePost(
  market: MarketData,
  traders: TraderData[],
  stats: AggregateStats,
  persona: Persona
): { content: string; lang: 'en' | 'zh'; category: string } {
  const templates = trainingData.post_templates
  const category = pickCategoryForPersona(persona)
  const categoryTemplates = (templates as Record<string, string[]>)[category]

  // Filter templates by persona language
  let filtered = filterTemplatesByLanguage(categoryTemplates, persona)
  if (filtered.length === 0) filtered = categoryTemplates // fallback

  const template = pick(filtered)
  const trader = traders.length ? pick(traders) : { name: 'unknown', platform: 'binance', roi: 42, winRate: 55, score: 70 }
  const trader2 = traders.length > 1 ? pick(traders.filter(t => t.platform !== trader.platform)) : trader

  // For BTC maxi persona, always use BTC
  let coin: string
  if (persona.topics.includes('btc') && !persona.topics.includes('altcoins') && !persona.topics.includes('defi')) {
    coin = '$BTC'
  } else if (persona.topics.includes('defi') || persona.topics.includes('on_chain')) {
    coin = pick(['$ETH', '$SOL'])
  } else {
    coin = pick(['$BTC', '$ETH', '$SOL'])
  }

  const coinPrice = coin === '$BTC' ? market.btcPrice : coin === '$ETH' ? market.ethPrice : market.solPrice
  const coin24h = coin === '$BTC' ? market.btc24h : coin === '$ETH' ? market.eth24h : market.sol24h
  const direction = coin24h > 0 ? '涨' : '跌'

  // For DeFi persona, prefer DEX platforms
  let platform: string
  if (persona.topics.includes('defi') || persona.topics.includes('dex')) {
    platform = pick(['hyperliquid', 'gmx', 'drift', 'vertex', 'dydx'])
  } else if (persona.topics.includes('exchange_comparison')) {
    platform = trader.platform !== 'unknown' ? trader.platform : pick(['binance', 'bybit', 'okx', 'bitget'])
  } else {
    platform = trader.platform !== 'unknown' ? trader.platform : pick(['binance', 'hyperliquid', 'okx', 'bybit', 'bitget', 'gmx', 'drift'])
  }

  const isZh = /[\u4e00-\u9fff]/.test(template)
  const lang = isZh ? 'zh' as const : 'en' as const

  const pnlStr = trader.roi > 100 ? String(Math.round(trader.roi * 100)) : String(randInt(500, 50000))
  const scoreComment = pick(['not bad', 'pain', 'improving', '还行', '太菜了', '有进步'])
  let content = template
    .replace(/\{price\}/g, formatPrice(coinPrice))
    .replace(/\{coin\}/g, coin)
    .replace(/\{direction\}/g, direction)
    .replace(/\{comment\}/g, pick(['等方向', 'patient', '不动了', 'looking good']))
    .replace(/\{target\}/g, formatPrice(coinPrice * 1.05))
    .replace(/\{amount\}/g, String(randInt(100, 800)))
    .replace(/\{entry\}/g, String(Math.round(coinPrice * (1 - Math.random() * 0.03))))
    .replace(/\{exit\}/g, String(Math.round(coinPrice * (1 + Math.random() * 0.03))))
    .replace(/\{period\}/g, pick(['7', '30', '90']))
    .replace(/\{roi\}/g, String(trader.roi))
    .replace(/\{wr\}/g, String(trader.winRate || randInt(30, 70)))
    .replace(/\{traderName\}/g, trader.name)
    .replace(/\{pnl\}/g, pnlStr)
    .replace(/\{score\}/g, String(trader.score))
    .replace(/\{totalTraders\}/g, String(stats.totalTraders))
    .replace(/\{profitPct\}/g, String(stats.profitPct))
    .replace(/\{lossPct\}/g, String(100 - stats.profitPct))
    .replace(/\{topPct\}/g, String(stats.topPct))
    .replace(/\{avgWR\}/g, String(stats.avgWinRate))
    .replace(/\{platformCount\}/g, String(stats.platformCount))
    .replace(/\{lowWR\}/g, String(stats.lowestWRWithHighScore))
    .replace(/\{platform1\}/g, trader.platform)
    .replace(/\{platform2\}/g, trader2.platform)
    .replace(/\{roi1\}/g, String(trader.roi))
    .replace(/\{roi2\}/g, String(trader2.roi))
    .replace(/\{rank\}/g, String(randInt(3, 25)))
    .replace(/\{score1\}/g, String(randInt(25, 50)))
    .replace(/\{score2\}/g, String(randInt(30, 55)))
    .replace(/\{scoreComment\}/g, scoreComment)
    .replace(/\{platform\}/g, platform)
    .replace(/\{feature\}/g, pick(['claim', 'watchlist', 'compare', 'filter']))

  return { content, lang, category }
}

// --- Reply generation ---

function generateReply(
  originalContent: string,
  originalPersona: Persona,
  replyPersona: Persona,
  market: MarketData,
  traders: TraderData[]
): string {
  const isZh = replyPersona.language === 'zh'
  const oc = originalContent.toLowerCase()

  // BTC maxi replying to DeFi degen
  if (replyPersona.topics.includes('btc') && !replyPersona.topics.includes('defi')) {
    if (oc.includes('defi') || oc.includes('gmx') || oc.includes('hyperliquid') || oc.includes('dex') || oc.includes('eth') || oc.includes('sol')) {
      return pick([
        'all of this goes to zero eventually. btc is the only exit',
        'imagine trading alts when btc exists',
        'dex roi means nothing if the chain rugs',
        'number go up technology is btc. everything else is noise',
        'cool now price it in btc',
      ])
    }
  }

  // DeFi degen replying to BTC maxi
  if (replyPersona.topics.includes('defi') && oc.includes('btc')) {
    return pick([
      'btc maxis still not understanding composability in 2026',
      'cant yield farm btc tho',
      'imagine not using on-chain perps',
      'btc is a boomer rock. the real alpha is on-chain',
      'wake me up when btc has smart contracts',
    ])
  }

  // Risk manager replying to leverage degen
  if (replyPersona.topics.includes('risk') || replyPersona.topics.includes('sharpe')) {
    if (oc.includes('leverage') || oc.includes('liquidat') || oc.includes('rekt') || oc.includes('爆仓') || oc.includes('梭哈')) {
      return pick([
        'this is why position sizing exists',
        'what was your risk/reward on that',
        'kelly criterion would have saved you here',
        'max drawdown on that strategy must be insane',
        'sharpe ratio of yolo is technically undefined',
      ])
    }
  }

  // Skeptic replying to bullish posts
  if (replyPersona.topics.includes('contrarian') || replyPersona.topics.includes('skepticism')) {
    return pick([
      'everyone is bullish. you know what that means',
      'this is exactly what people said before the last crash',
      'inverse this for alpha',
      'funding rate disagrees with you',
      'reminder that 80% of traders lose money',
    ])
  }

  // Chinese degen replying to another degen about rekt
  if (isZh && (oc.includes('爆仓') || oc.includes('rekt') || oc.includes('亏'))) {
    return pick([
      '兄弟 我也是',
      '别说了 一样的',
      '抱团取暖',
      '这波我也中招了',
      '别急 下次还会亏的',
    ])
  }

  // Yangsheng replying to stressed traders
  if (replyPersona.handle === 'yangsheng') {
    return pick([
      '先喝杯茶 别急',
      '身体最重要 钱没了可以再赚',
      '建议少看盘 多运动',
      '熬夜看盘伤身体',
      '炒币要佛系',
    ])
  }

  // Newbie replying with questions
  if (replyPersona.topics.includes('learning') || replyPersona.topics.includes('questions')) {
    if (isZh) {
      return pick([
        '大佬 这个怎么操作的',
        '小白问一下 这个在哪里看',
        '刚入场 能解释一下吗',
        '这个score是怎么算的',
      ])
    }
    return pick([
      'wait how do you check this',
      'noob question but what platform is this on',
      'can someone explain arena score to me',
      'is this normal or am i reading it wrong',
    ])
  }

  // Bot runner replying about manual trading
  if (replyPersona.handle === 'botrunner') {
    return pick([
      'this is why you automate',
      'a bot would have handled this better',
      'humans are the weakest link in trading',
      'my bot doesnt sleep, doesnt panic, doesnt fomo',
    ])
  }

  // Exchange reviewer comparing
  if (replyPersona.handle === 'cexwatcher') {
    return pick([
      'how does this compare to other platforms',
      'interesting, the fees on that platform are rough though',
      'have you tried the same strategy on bybit',
      'the leaderboard on that exchange is way less transparent',
    ])
  }

  // Generic contrasting reply
  if (isZh) {
    return pick([
      '不太同意',
      '我觉得反了',
      '想法不一样 但尊重',
      '再观察观察',
      '有一定道理 但也不一定',
    ])
  }
  return pick([
    'interesting take but i see it differently',
    'disagree but respect the conviction',
    'not sure about this one',
    'gonna need more data on that',
    'could go either way honestly',
  ])
}

// --- Comment generation ---

type CommentType = 'generic' | 'content_ref' | 'disagree' | 'question'

function generateComment(postContent: string, postLang: 'en' | 'zh', traders: TraderData[]): string {
  const types: CommentType[] = ['generic', 'content_ref', 'disagree', 'question']
  const weights = [40, 30, 15, 15]
  const ctype = weightedPick(types, weights)

  switch (ctype) {
    case 'content_ref':
      return generateContentRefComment(postContent, /[\u4e00-\u9fff]/.test(postContent), traders)
    case 'disagree':
      return generateDisagreeComment(postContent, /[\u4e00-\u9fff]/.test(postContent))
    case 'question':
      return generateQuestionComment(postContent, /[\u4e00-\u9fff]/.test(postContent))
    default:
      return generateGenericComment(postContent, /[\u4e00-\u9fff]/.test(postContent))
  }
}

function generateContentRefComment(post: string, isZh: boolean, traders: TraderData[]): string {
  const c = post.toLowerCase()

  const coinMatch = c.match(/\$?(btc|eth|sol)/i)
  const roiMatch = post.match(/(\d+)%?\s*(roi|收益)/i) || post.match(/(roi|收益)\s*(\d+)/i)
  const platformMatch = c.match(/(binance|bybit|okx|bitget|hyperliquid|gmx|drift|mexc)/i)
  const priceMatch = post.match(/(\d+k)/i)

  if (coinMatch) {
    const coin = coinMatch[1].toUpperCase()
    if (isZh) {
      return pick([
        `${coin}这波行情确实猛`,
        `${coin}还能追吗`,
        `${coin}我也在看 等回调`,
        `${coin}我重仓了`,
        `${coin}最近波动太大了`,
      ])
    }
    return pick([
      `${coin} looking good ngl`,
      `been watching ${coin} too`,
      `${coin} has more room imo`,
      `${coin} overextended here`,
      `my ${coin} bag appreciates this`,
    ])
  }

  if (platformMatch) {
    const plat = platformMatch[1].toLowerCase()
    if (isZh) {
      return pick([
        `${plat}上确实有猛人`,
        `${plat}排行榜看过了 真离谱`,
        `${plat}的数据更新挺快`,
      ])
    }
    return pick([
      `${plat} leaderboard is wild rn`,
      `been tracking ${plat} too`,
      `${plat} has some insane traders`,
    ])
  }

  if (roiMatch) {
    if (isZh) return pick(['这个roi真的假的', '收益太猛了', '怎么做到的 求带'])
    return pick(['that roi is insane', 'how tho', 'need that kind of returns'])
  }

  if (priceMatch) {
    if (isZh) {
      return pick([
        `${priceMatch[1]}这个位置很关键`,
        `到${priceMatch[1]}了?`,
        `${priceMatch[1]}附近压力很大`,
      ])
    }
    return pick([
      `${priceMatch[1]} is the level to watch`,
      `we touching ${priceMatch[1]}?`,
      `${priceMatch[1]} resistance gonna be tough`,
    ])
  }

  if (isZh) return pick(['说的有道理', '确实是这样', '我也这么觉得', '说到点子上了'])
  return pick(['this is the take', 'nailed it', 'exactly what i was thinking', 'solid point'])
}

function generateDisagreeComment(post: string, isZh: boolean): string {
  if (isZh) {
    return pick([
      '不一定吧', '我觉得反了', '别太乐观了', 'risky imo',
      '这个逻辑有问题', '再看看吧 别急', '不太同意', '小心被套', '上次也这么说 结果呢',
    ])
  }
  return pick([
    'idk about that', 'risky imo', 'disagree but ok', 'careful with that',
    'not so sure about this one', 'could go either way tbh', 'last time people said this...',
    'hope you have a stop loss', 'gonna age badly imo',
  ])
}

function generateQuestionComment(post: string, isZh: boolean): string {
  const c = post.toLowerCase()
  const coinMatch = c.match(/\$?(btc|eth|sol)/i)
  const platformMatch = c.match(/(binance|bybit|okx|bitget|hyperliquid|gmx|drift|mexc)/i)

  if (isZh) {
    const qs = ['哪个交易所的', '什么时候进的', '仓位多大', '止损在哪', '能说说逻辑吗', '链接有吗']
    if (platformMatch) qs.push(`${platformMatch[1]}怎么看排行榜`)
    if (coinMatch) qs.push(`${coinMatch[1].toUpperCase()}目标价多少`)
    return pick(qs)
  }

  const qs = ['which trader?', 'link?', 'what exchange?', 'entry price?', 'whats your target', 'how long you holding', 'what timeframe']
  if (platformMatch) qs.push(`how do you find traders on ${platformMatch[1]}?`)
  if (coinMatch) qs.push(`what's your ${coinMatch[1].toUpperCase()} target?`)
  return pick(qs)
}

function generateGenericComment(post: string, isZh: boolean): string {
  const templates = trainingData.comment_templates
  const c = post.toLowerCase()

  let pool: string[] = []
  if (c.includes('btc') || c.includes('eth') || c.includes('sol') || /\d+k/.test(c)) {
    pool.push(...templates.price_comment)
  }
  if (c.includes('short') || c.includes('空') || c.includes('loss') || c.includes('爆')) {
    pool.push(...templates.empathy)
  }
  if (c.includes('?') || c.includes('吗') || c.includes('how')) {
    pool.push(...templates.question_response)
  }
  if (isZh) {
    pool.push(...templates.agreement, ...templates.surprise, ...templates.humor)
  } else {
    pool.push(...templates.agreement, ...templates.surprise)
  }

  return pick(pool)
}

// --- Main ---

async function main() {
  const count = parseInt(process.argv[2] || '10')
  console.log(`Generating ${count} posts with persona system...`)

  const [market, traders, stats] = await Promise.all([getMarketData(), getLeaderboardData(), getAggregateStats()])
  console.log(`Market: BTC $${market.btcPrice} (${market.btc24h}%) ETH $${market.ethPrice} (${market.eth24h}%) SOL $${market.solPrice} (${market.sol24h}%)`)
  console.log(`Volatile: ${market.isVolatile}`)
  console.log(`Traders: ${traders.length} loaded | Total: ${stats.totalTraders} | Profitable: ${stats.profitPct}% | Score 80+: ${stats.topPct}%`)
  if (traders.length > 0) {
    console.log(`  Top 3: ${traders.slice(0, 3).map(t => `${t.name} (${t.platform}, ${t.roi}% ROI, score ${t.score})`).join(', ')}`)
  }

  // Get seed users
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .not('handle', 'in', '(Arena,system,test,Adeline,broosbook,Jingwen)')

  if (!users?.length) {
    console.error('No seed users found')
    return
  }
  console.log(`Seed users: ${users.length}`)
  console.log(`Personas loaded: ${personas.length}`)

  // Build handle -> user map
  const userByHandle = new Map<string, UserRecord>()
  for (const u of users) {
    userByHandle.set(u.handle, u)
  }

  // Only use users that have a persona defined
  const usersWithPersonas = users.filter(u => getPersona(u.handle))
  const usersWithoutPersonas = users.filter(u => !getPersona(u.handle))
  if (usersWithoutPersonas.length > 0) {
    console.log(`  Users without persona (will be used less): ${usersWithoutPersonas.map(u => u.handle).join(', ')}`)
  }
  console.log(`  Users with persona: ${usersWithPersonas.length}`)

  // Build time slots
  const daySlots = buildDaySlots(count, market.isVolatile)
  console.log(`\nDay distribution:`)
  daySlots.forEach(s => {
    const dayName = s.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    console.log(`  ${dayName}${s.isWeekend ? ' (weekend)' : ''}: ${s.postCount} posts`)
  })

  let postsAdded = 0
  let repliesAdded = 0
  let commentsAdded = 0
  let pollsAdded = 0

  // Track posts per user to ensure diversity
  const postsPerUser = new Map<string, number>()

  for (const slot of daySlots) {
    for (let p = 0; p < slot.postCount; p++) {
      // Pick user with persona, preferring users who have posted less
      const user = pickLeastPosted(usersWithPersonas, postsPerUser)
      const persona = getPersona(user.handle)!

      const { content, lang, category } = generatePost(market, traders, stats, persona)
      const ts = randomTimeForDay(slot.date, lang)

      // Prediction polls: set poll data for prediction_ask posts
      const isPrediction = category === 'prediction_ask'
      const pollData = isPrediction ? {
        poll_enabled: true,
        poll_bull: randInt(10, 35),
        poll_bear: randInt(8, 30),
        poll_wait: randInt(3, 15),
      } : {}

      const { error } = await supabase.from('posts').insert({
        author_id: user.id,
        author_handle: user.handle,
        author_avatar_url: user.avatar_url,
        title: '',
        content,
        status: 'active',
        hot_score: randInt(15, 55),
        like_count: randInt(1, 20),
        created_at: ts.toISOString(),
        ...pollData,
      })

      if (error) {
        console.log(`ERR post: ${error.message}`)
        continue
      }
      postsAdded++
      postsPerUser.set(user.handle, (postsPerUser.get(user.handle) || 0) + 1)
      if (isPrediction) pollsAdded++

      // Get the post id
      const { data: newPost } = await supabase
        .from('posts')
        .select('id')
        .eq('author_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!newPost) continue

      const timeStr = ts.toISOString().replace('T', ' ').slice(0, 16)
      const pollTag = isPrediction ? ' [POLL]' : ''
      console.log(`  [${timeStr}] @${user.handle} (${lang}, ${category}${pollTag}): ${content.slice(0, 60)}...`)

      // --- Reply chain: ~30% chance ---
      if (Math.random() < 0.3 && usersWithPersonas.length > 1) {
        const contrastPersona = findContrastingPersona(persona, personas)
        if (contrastPersona) {
          const replyUser = userByHandle.get(contrastPersona.handle)
          if (replyUser && replyUser.id !== user.id) {
            const replyContent = generateReply(content, persona, contrastPersona, market, traders)
            const replyOffsetMs = randInt(1, 6) * 3600000 + randInt(0, 3600) * 1000
            const replyTs = new Date(Math.min(ts.getTime() + replyOffsetMs, Date.now()))

            // Insert reply as a post with original_post_id (quote/reply)
            const { error: replyErr } = await supabase.from('posts').insert({
              author_id: replyUser.id,
              author_handle: replyUser.handle,
              author_avatar_url: replyUser.avatar_url,
              title: '',
              content: replyContent,
              status: 'active',
              hot_score: randInt(10, 40),
              like_count: randInt(1, 12),
              original_post_id: newPost.id,
              created_at: replyTs.toISOString(),
            })

            if (!replyErr) {
              repliesAdded++
              console.log(`    ↳ @${replyUser.handle} replied: ${replyContent.slice(0, 50)}...`)
            }
          }
        }
      }

      // --- Comments ---
      const numComments = randInt(2, 4)
      const otherUsers = users.filter(u => u.id !== user.id)
      if (otherUsers.length === 0) continue

      const usedCommenters = new Set<string>()
      for (let j = 0; j < numComments; j++) {
        const available = otherUsers.filter(u => !usedCommenters.has(u.id))
        if (available.length === 0) break
        const commenter = pick(available)
        usedCommenters.add(commenter.id)

        const comment = generateComment(content, lang, traders)
        const offsetMs = (0.2 + Math.random() * 12) * 3600000
        const cd = new Date(Math.min(ts.getTime() + offsetMs, Date.now()))

        const { error: cErr } = await supabase.from('comments').insert({
          post_id: newPost.id,
          user_id: commenter.id,
          author_id: commenter.id,
          author_handle: commenter.handle,
          content: comment,
          created_at: cd.toISOString(),
        })

        if (!cErr) commentsAdded++
      }

      // Update comment count
      const { count: cmtCount } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', newPost.id)
      await supabase.from('posts').update({ comment_count: cmtCount || 0 }).eq('id', newPost.id)
    }
  }

  console.log(`\nDone: ${postsAdded} posts, ${repliesAdded} reply chains, ${commentsAdded} comments, ${pollsAdded} polls`)
  console.log(`\nPosts per user:`)
  const sorted = [...postsPerUser.entries()].sort((a, b) => b[1] - a[1])
  for (const [handle, count] of sorted) {
    const p = getPersona(handle)
    console.log(`  @${handle} (${p?.language || '??'}): ${count} posts — ${p?.persona.slice(0, 50) || 'no persona'}`)
  }
}

/** Pick user who has posted least, for diversity */
function pickLeastPosted(users: UserRecord[], counts: Map<string, number>): UserRecord {
  const minCount = Math.min(...users.map(u => counts.get(u.handle) || 0))
  const leastPosted = users.filter(u => (counts.get(u.handle) || 0) === minCount)
  return pick(leastPosted)
}

main().catch(console.error)
