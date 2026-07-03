jest.mock('@/lib/i18n', () => ({ t: (k: string) => k }))
jest.mock('@/lib/design-tokens', () => ({ tokens: { colors: { text: { tertiary: '#999' } } } }))
jest.mock('@/lib/constants/exchanges', () => ({
  SOURCE_TYPE_MAP: { binance_futures: 'futures', okx_spot: 'spot' },
  EXCHANGE_NAMES: { binance_futures: 'Binance', mexc: 'MEXC' },
}))
jest.mock('@/lib/utils/format', () => ({
  formatROI: (x: number) => `${x}%`,
  formatPnL: (x: number) => `$${x}`,
}))

import { formatDisplayName, getMedalGlowClass, getPnLTooltip, parseSourceInfo } from '../utils'

describe('formatDisplayName', () => {
  it('null/占位字符串 → Unknown', () => {
    expect(formatDisplayName('')).toBe('Unknown')
    expect(formatDisplayName('null')).toBe('Unknown')
    expect(formatDisplayName('undefined')).toBe('Unknown')
  })

  it('0x 钱包地址 → 中间截断（6...4）', () => {
    expect(formatDisplayName('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
  })

  it('Copin 协议格式 protocol:0xAddr → 提取并截断地址', () => {
    const out = formatDisplayName('gmx_v2:0x1234567890abcdef1234567890abcdef12345678')
    expect(out).toBe('0x1234...5678')
  })

  it('base58 钱包（Solana，无 0x）→ 4...4 截断', () => {
    // 44 位 base58（不含 0/O/I/l）
    expect(formatDisplayName('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe('9WzD...AWWM')
  })

  it('纯数字 ID → #后6位', () => {
    expect(formatDisplayName('12345678')).toBe('#345678')
  })

  it('脱敏邮箱/星号 + platform → "{Platform} Trader"（真实用法都传 platform）', () => {
    // 所有调用点都传 source/platform（TraderRow/TraderCard/HeroSection 等）
    expect(formatDisplayName('*******277', 'binance_futures')).toBe('Binance Trader')
    expect(formatDisplayName('ma***6@gmail.com', 'binance_futures')).toBe('Binance Trader')
  })

  it('中台未注册占位 + platform → "{Platform} Trader"', () => {
    expect(formatDisplayName('中台未注册trader', 'binance_futures')).toBe('Binance Trader')
  })

  it('边界：无 platform 的占位名 → ""（sanitizeDisplayName 剥离裸 "trader"；调用方回退地址）', () => {
    // 记录交互行为：formatDisplayName 返回裸 "Trader"，profanity 过滤把占位名 'trader' 清空。
    // 生产不可达（所有调用点都传 platform），但锁住行为防未来误改。
    expect(formatDisplayName('中台未注册trader')).toBe('')
  })

  it('超长名（>60）→ 截断 57+...', () => {
    const long = 'a'.repeat(70)
    const out = formatDisplayName(long)
    expect(out.length).toBe(60) // 57 + '...'
    expect(out.endsWith('...')).toBe(true)
  })

  it('正常名 → 原样（经脏词过滤）', () => {
    expect(formatDisplayName('CryptoWhale')).toBe('CryptoWhale')
  })

  it('脏词名 → 打码', () => {
    expect(formatDisplayName('fuck')).toBe('f**k')
  })

  it('0x 地址 ≤20 字符 → 不截断（走 else）', () => {
    expect(formatDisplayName('0xshort')).toBe('0xshort')
  })
})

describe('getMedalGlowClass', () => {
  it('前 3 名各自 glow class，其余空', () => {
    expect(getMedalGlowClass(1)).toBe('medal-glow-gold')
    expect(getMedalGlowClass(2)).toBe('medal-glow-silver')
    expect(getMedalGlowClass(3)).toBe('medal-glow-bronze')
    expect(getMedalGlowClass(4)).toBe('')
    expect(getMedalGlowClass(0)).toBe('')
  })
})

describe('getPnLTooltip', () => {
  it('binance 系 → 交易员本人盈亏', () => {
    expect(getPnLTooltip('binance_futures', 'en')).toBe('pnlTraderOwn')
  })

  it('bybit/bitget/kucoin 系 → 跟单者收益', () => {
    expect(getPnLTooltip('bybit', 'en')).toBe('pnlFollowers')
    expect(getPnLTooltip('bitget_futures', 'en')).toBe('pnlFollowers')
  })

  it('其他 → 默认', () => {
    expect(getPnLTooltip('hyperliquid', 'en')).toBe('pnlDefault')
  })
})

describe('parseSourceInfo', () => {
  const t = (k: string) => k
  it('已知 source → 交易所名 + 类型', () => {
    const info = parseSourceInfo('binance_futures', t)
    expect(info.exchange).toBe('Binance')
    expect(info.type).toBe('categoryFutures')
  })

  it('未知 source → 首字母大写兜底 + futures 默认', () => {
    const info = parseSourceInfo('newexchange_spot', t)
    expect(info.exchange).toBe('Newexchange')
  })
})
