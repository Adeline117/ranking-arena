import {
  getPlatformCapabilities,
  isDexPlatform,
  requiresProxy,
  getSupportedWindows,
  PLATFORM_CAPABILITIES,
} from '../capabilities'

describe('getPlatformCapabilities', () => {
  it('已知平台返回其声明', () => {
    const caps = getPlatformCapabilities('binance_futures')
    expect(caps.fields.roi).toBe(true)
    expect(caps.api.geo_restricted).toBe(true)
    expect(caps.format.roi_format).toBe('percentage')
  })

  it('别名解析到同一声明对象', () => {
    expect(getPlatformCapabilities('bybit')).toBe(getPlatformCapabilities('bybit_futures'))
    expect(getPlatformCapabilities('bitget')).toBe(getPlatformCapabilities('bitget_futures'))
  })

  it('未知平台 → 保守默认（win_rate/copiers 等关闭）', () => {
    const caps = getPlatformCapabilities('nonexistent_exchange')
    expect(caps.fields.roi).toBe(true) // 默认仍认为有 roi/pnl
    expect(caps.fields.pnl).toBe(true)
    expect(caps.fields.win_rate).toBe(false)
    expect(caps.fields.copiers).toBe(false)
    expect(caps.supported_windows).toEqual(['7d', '30d', '90d'])
  })

  it('decimal 格式的交易所被正确标注（bitunix/bingx/drift）', () => {
    expect(getPlatformCapabilities('bitunix').format.roi_format).toBe('decimal')
    expect(getPlatformCapabilities('bingx').format.roi_format).toBe('decimal')
    expect(getPlatformCapabilities('drift').format.roi_format).toBe('decimal')
  })

  it('hyperliquid roi 需运行时检测格式', () => {
    expect(getPlatformCapabilities('hyperliquid').format.roi_format).toBe('needs_detection')
  })

  it('wei 单位的链上源带 pnl_decimals', () => {
    expect(getPlatformCapabilities('gmx').format.pnl_unit).toBe('wei')
    expect(getPlatformCapabilities('gmx').format.pnl_decimals).toBe(30) // GMX v2
    expect(getPlatformCapabilities('gains').format.pnl_decimals).toBe(18)
  })
})

describe('isDexPlatform', () => {
  it('DEX/perp 平台 → true', () => {
    for (const p of [
      'hyperliquid',
      'gmx',
      'dydx',
      'drift',
      'aevo',
      'gains',
      'jupiter_perps',
      'kwenta',
    ]) {
      expect(isDexPlatform(p)).toBe(true)
    }
  })

  it('CEX 平台 → false', () => {
    for (const p of ['binance_futures', 'bybit', 'okx_futures', 'bitget', 'mexc', 'kucoin']) {
      expect(isDexPlatform(p)).toBe(false)
    }
  })

  it('polymarket（预测市场，非 perp DEX）→ false', () => {
    expect(isDexPlatform('polymarket')).toBe(false)
  })

  it('未知平台 → false', () => {
    expect(isDexPlatform('whatever')).toBe(false)
  })
})

describe('requiresProxy', () => {
  it('geo 封锁/CF 保护的交易所需代理', () => {
    expect(requiresProxy('binance_futures')).toBe(true) // geo_restricted
    expect(requiresProxy('kucoin')).toBe(true) // CF protected
    expect(requiresProxy('bingx')).toBe(true) // CF protected
  })

  it('无封锁的交易所不需代理', () => {
    expect(requiresProxy('bitget')).toBe(false)
    expect(requiresProxy('mexc')).toBe(false)
    expect(requiresProxy('hyperliquid')).toBe(false)
  })

  it('未知平台 → 默认 false（保守默认不需代理）', () => {
    expect(requiresProxy('unknown')).toBe(false)
  })
})

describe('getSupportedWindows', () => {
  it('binance_futures 含 all_time', () => {
    expect(getSupportedWindows('binance_futures')).toContain('all_time')
  })

  it('okx_futures 无 all_time', () => {
    expect(getSupportedWindows('okx_futures')).not.toContain('all_time')
  })

  it('gmx 仅 all_time（subgraph 限制）', () => {
    expect(getSupportedWindows('gmx')).toEqual(['all_time'])
  })

  it('未知平台 → 默认 7d/30d/90d', () => {
    expect(getSupportedWindows('unknown')).toEqual(['7d', '30d', '90d'])
  })
})

describe('PLATFORM_CAPABILITIES 注册表一致性', () => {
  it('所有 isDexPlatform=true 的源都在注册表中', () => {
    for (const p of [
      'hyperliquid',
      'gmx',
      'dydx',
      'drift',
      'aevo',
      'gains',
      'jupiter_perps',
      'kwenta',
    ]) {
      expect(PLATFORM_CAPABILITIES[p]).toBeDefined()
    }
  })

  it('每个声明都有完整的 fields/api/format 三段', () => {
    for (const caps of Object.values(PLATFORM_CAPABILITIES)) {
      expect(caps.fields).toBeDefined()
      expect(caps.api).toBeDefined()
      expect(caps.format).toBeDefined()
      expect(Array.isArray(caps.supported_windows)).toBe(true)
    }
  })
})
