jest.mock('@/lib/utils/logger', () => ({
  dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/lib/cache', () => ({ get: jest.fn(), set: jest.fn() }))

import { CircuitBreakerManager } from '../circuit-breaker'

// 每个测试用小阈值 + 短 openDuration，配合 fake timers 精确控制状态转换
const CFG = {
  failureThreshold: 3,
  latencyThreshold: 1000,
  slowRequestThreshold: 2,
  openDuration: 5000,
  halfOpenRequests: 2,
  successThreshold: 2,
  statisticsWindowMs: 60000,
}

describe('CircuitBreakerManager — 状态机', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('全新服务 → CLOSED + 允许请求', () => {
    const m = new CircuitBreakerManager(CFG)
    expect(m.getState('svc')).toBe('CLOSED')
    expect(m.canRequest('svc')).toBe(true)
  })

  it('连续失败达阈值 → 跳闸到 OPEN + 拒绝请求', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordFailure('svc')
    m.recordFailure('svc')
    expect(m.getState('svc')).toBe('CLOSED') // 还没到 3
    m.recordFailure('svc')
    expect(m.getState('svc')).toBe('OPEN')
    expect(m.canRequest('svc')).toBe(false)
  })

  it('CLOSED 下成功请求重置失败计数（连续性要求）', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordFailure('svc')
    m.recordFailure('svc')
    m.recordSuccess('svc', 100) // 重置 failures → 0
    m.recordFailure('svc')
    m.recordFailure('svc')
    expect(m.getState('svc')).toBe('CLOSED') // 只累积到 2，未跳闸
  })

  it('OPEN 经过 openDuration → 自动转 HALF_OPEN', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('svc')
    expect(m.getState('svc')).toBe('OPEN')
    jest.advanceTimersByTime(4999)
    expect(m.getState('svc')).toBe('OPEN') // 还差 1ms
    jest.advanceTimersByTime(2)
    expect(m.getState('svc')).toBe('HALF_OPEN')
  })

  it('HALF_OPEN 下累计 successThreshold 次成功 → 恢复 CLOSED', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('svc')
    jest.advanceTimersByTime(5001)
    expect(m.getState('svc')).toBe('HALF_OPEN')
    m.recordSuccess('svc', 100)
    expect(m.getState('svc')).toBe('HALF_OPEN') // 1 次还不够
    m.recordSuccess('svc', 100)
    expect(m.getState('svc')).toBe('CLOSED') // 达 successThreshold=2
  })

  it('HALF_OPEN 下一次失败 → 立即回 OPEN', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('svc')
    jest.advanceTimersByTime(5001)
    expect(m.getState('svc')).toBe('HALF_OPEN')
    m.recordFailure('svc')
    expect(m.getState('svc')).toBe('OPEN')
  })

  it('HALF_OPEN 探测请求数受 halfOpenRequests 限制', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('svc')
    jest.advanceTimersByTime(5001)
    m.getState('svc') // 触发转 HALF_OPEN
    expect(m.canRequest('svc')).toBe(true) // 0 探测
    m.recordSuccess('svc', 100) // 1 探测（还在 HALF_OPEN，未达 successThreshold=2）
    expect(m.canRequest('svc')).toBe(true) // 1 < 2
  })

  it('慢请求累计达 slowRequestThreshold → 跳闸', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordSuccess('svc', 2000) // 慢（>1000）
    expect(m.getState('svc')).toBe('CLOSED')
    m.recordSuccess('svc', 2000) // 第 2 次慢 → 达 slowRequestThreshold=2
    expect(m.getState('svc')).toBe('OPEN')
  })

  it('统计窗口过期 → 失败计数重置', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordFailure('svc')
    m.recordFailure('svc')
    jest.advanceTimersByTime(60001) // 超过 statisticsWindowMs
    m.recordFailure('svc') // checkWindowReset 先清零，这是窗口内第 1 次
    expect(m.getState('svc')).toBe('CLOSED') // 未跳闸
  })

  it('reset 强制回 CLOSED', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('svc')
    expect(m.getState('svc')).toBe('OPEN')
    m.reset('svc')
    expect(m.getState('svc')).toBe('CLOSED')
    expect(m.canRequest('svc')).toBe(true)
  })

  it('每个服务独立熔断，互不影响', () => {
    const m = new CircuitBreakerManager(CFG)
    for (let i = 0; i < 3; i++) m.recordFailure('a')
    expect(m.getState('a')).toBe('OPEN')
    expect(m.getState('b')).toBe('CLOSED') // b 不受 a 影响
  })

  it('getStats 返回副本（不可变外泄）', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordSuccess('svc', 50)
    const s1 = m.getStats('svc')
    s1.failures = 999 // 篡改副本
    expect(m.getStats('svc').failures).toBe(0) // 内部不受影响
  })

  it('getAllStats 汇总所有已知服务', () => {
    const m = new CircuitBreakerManager(CFG)
    m.recordSuccess('a', 50)
    m.recordFailure('b')
    const all = m.getAllStats()
    expect(Object.keys(all).sort()).toEqual(['a', 'b'])
  })

  it('configure 覆盖单服务阈值', () => {
    const m = new CircuitBreakerManager(CFG)
    m.configure('svc', { failureThreshold: 1 })
    m.recordFailure('svc') // 1 次即跳闸
    expect(m.getState('svc')).toBe('OPEN')
  })
})
