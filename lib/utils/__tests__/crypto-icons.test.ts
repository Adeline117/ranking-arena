import {
  normalizeCoinSymbol,
  getSymbolLabel,
  getCryptoIconPath,
  getGenericIconPath,
} from '../crypto-icons'

describe('normalizeCoinSymbol', () => {
  it('拼接式 BTCUSDT → btc', () => {
    expect(normalizeCoinSymbol('BTCUSDT')).toBe('btc')
  })

  it('斜杠/连字符分隔 → base', () => {
    expect(normalizeCoinSymbol('BTC/USDT')).toBe('btc')
    expect(normalizeCoinSymbol('ETH-USD')).toBe('eth')
  })

  it('USDC 后缀正确剥离（不被 USD 提前截断）', () => {
    // 交替顺序 USD 在 USDC 前，但 $ 锚点保证匹配到 USDC
    expect(normalizeCoinSymbol('ETHUSDC')).toBe('eth')
  })

  it('各 quote 后缀都能剥离', () => {
    expect(normalizeCoinSymbol('SOLBUSD')).toBe('sol')
    expect(normalizeCoinSymbol('DOGEPERP')).toBe('doge')
    expect(normalizeCoinSymbol('XRPSWAP')).toBe('xrp')
  })

  it('Hyperliquid xyz: 前缀剥离', () => {
    expect(normalizeCoinSymbol('xyz:tsla')).toBe('tsla')
    expect(normalizeCoinSymbol('xyz:cl')).toBe('cl')
  })

  it('纯 quote 币（USDT/USDC 本身）→ 保留原符号不返回空', () => {
    expect(normalizeCoinSymbol('USDT')).toBe('usdt')
    expect(normalizeCoinSymbol('USDC')).toBe('usdc')
  })

  it('结果统一小写 + trim', () => {
    expect(normalizeCoinSymbol('  BTC  ')).toBe('btc')
    expect(normalizeCoinSymbol('Sol/USDT')).toBe('sol')
  })

  it('无后缀的裸符号原样（小写）', () => {
    expect(normalizeCoinSymbol('PEPE')).toBe('pepe')
  })
})

describe('getSymbolLabel', () => {
  it('取前 2 字符大写', () => {
    expect(getSymbolLabel('btc')).toBe('BT')
    expect(getSymbolLabel('ethusdt')).toBe('ET') // 剥后缀后 eth → ET
  })

  it('xyz: 前缀先剥离再取首字母', () => {
    expect(getSymbolLabel('xyz:tsla')).toBe('TS')
  })

  it('单字符符号 → 1 字符 label', () => {
    expect(getSymbolLabel('x')).toBe('X')
  })
})

describe('getCryptoIconPath / getGenericIconPath', () => {
  it('路径基于归一化符号', () => {
    expect(getCryptoIconPath('BTC/USDT')).toBe('/icons/crypto/btc.svg')
  })

  it('generic 兜底路径固定', () => {
    expect(getGenericIconPath()).toBe('/icons/crypto/generic.svg')
  })
})
