/**
 * connector-health-monitor — 批次间退化检测。
 * 行数骤降/ROI 中位漂移/完整度崩塌/API schema 变化 → warning/critical。
 * critical 不保存基线(防退化运行污染基线导致下次误报)。
 */

const mockStateGet = jest.fn()
const mockStateSet = jest.fn()
jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: (...a: unknown[]) => mockStateGet(...a),
    set: (...a: unknown[]) => mockStateSet(...a),
  },
}))
jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { checkConnectorHealth, type ConnectorHealthSnapshot } from '../connector-health-monitor'

function rows(count: number, roi = 10): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ roi_pct: roi + (i % 3), pnl_usd: 100 }))
}

function prevSnapshot(overrides: Partial<ConnectorHealthSnapshot> = {}): ConnectorHealthSnapshot {
  return {
    platform: 'bybit',
    window: '30d',
    timestamp: '2026-07-02T00:00:00Z',
    rowCount: 100,
    medianRoi: 11,
    roiNonNullPct: 100,
    pnlNonNullPct: 100,
    responseFingerprint: 'pnl_usd,roi_pct',
    ...overrides,
  }
}

beforeEach(() => {
  mockStateGet.mockReset()
  mockStateSet.mockReset().mockResolvedValue(undefined)
})

describe('基线建立', () => {
  it('无前次快照 → 保存基线,不算退化', async () => {
    mockStateGet.mockResolvedValue(null)
    const r = await checkConnectorHealth('bybit', '30d', rows(100))
    expect(r).toEqual({ isDegraded: false, severity: 'none', reasons: [] })
    expect(mockStateSet).toHaveBeenCalled()
  })

  it('前次 rowCount=0 → 同样重建基线', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 0 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(100))
    expect(r.isDegraded).toBe(false)
  })
})

describe('行数骤降', () => {
  it('降 >50%(基数>=50)→ critical', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 100 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(40))
    expect(r.severity).toBe('critical')
    expect(r.reasons[0]).toContain('Row count dropped 100 → 40')
  })

  it('降 30-50%(基数>=20)→ warning', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 100 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(65))
    expect(r.severity).toBe('warning')
  })

  it('小幅波动 → none', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 100 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(95))
    expect(r.severity).toBe('none')
    expect(r.isDegraded).toBe(false)
  })

  it('configuredLimit 主动调低 → 基线重置而非退化(200→100 限额变更)', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 200 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(95), 100)
    expect(r.severity).toBe('none') // 95 >= 100*0.7,视为主动限额
    expect(mockStateSet).toHaveBeenCalled() // 基线被重置
  })

  it('有 configuredLimit 但行数远低于限额 → 仍是真退化', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 200 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(30), 100) // 30 < 70
    expect(r.severity).toBe('critical')
  })
})

describe('ROI 中位漂移', () => {
  it('漂移 >5 倍 → critical', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ medianRoi: 10 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(100, 100)) // 中位 ~101
    expect(r.severity).toBe('critical')
    expect(r.reasons.some((x) => x.includes('Median ROI shifted'))).toBe(true)
  })

  it('漂移 2-5 倍 → warning', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ medianRoi: 10 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(100, 40)) // 中位 ~41,4 倍漂移
    expect(r.severity).toBe('warning')
  })

  it('前次中位 |x|<=1(接近 0)→ 跳过漂移检查(除法保护)', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ medianRoi: 0.5 }))
    const r = await checkConnectorHealth('bybit', '30d', rows(100, 50))
    expect(r.reasons.some((x) => x.includes('Median ROI'))).toBe(false)
  })
})

describe('完整度崩塌 + schema 变化', () => {
  it('roi 完整度 >80% → <20% → critical', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ roiNonNullPct: 100 }))
    const noRoi = Array.from({ length: 100 }, () => ({ pnl_usd: 100 })) // roi 全缺
    const r = await checkConnectorHealth('bybit', '30d', noRoi)
    expect(r.severity).toBe('critical')
    expect(r.reasons.some((x) => x.includes('ROI completeness'))).toBe(true)
  })

  it('响应指纹变化(字段增删)→ warning + 列出差异', async () => {
    mockStateGet.mockResolvedValue(
      prevSnapshot({ responseFingerprint: 'oldField,pnl_usd,roi_pct' })
    )
    const r = await checkConnectorHealth('bybit', '30d', rows(100))
    expect(r.severity).toBe('warning')
    expect(r.reasons.some((x) => x.includes('API schema changed') && x.includes('oldField'))).toBe(
      true
    )
  })
})

describe('critical 不保存基线(防污染)', () => {
  it('critical 退化 → 不写新快照,基线保持', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 100 }))
    await checkConnectorHealth('bybit', '30d', rows(40)) // critical
    expect(mockStateSet).not.toHaveBeenCalled()
  })

  it('warning → 保存新快照', async () => {
    mockStateGet.mockResolvedValue(prevSnapshot({ rowCount: 100 }))
    await checkConnectorHealth('bybit', '30d', rows(65)) // warning
    expect(mockStateSet).toHaveBeenCalled()
  })

  it('PipelineState.get 抛错 → 当首跑处理(不炸)', async () => {
    mockStateGet.mockRejectedValue(new Error('redis down'))
    const r = await checkConnectorHealth('bybit', '30d', rows(100))
    expect(r.isDegraded).toBe(false)
  })
})
