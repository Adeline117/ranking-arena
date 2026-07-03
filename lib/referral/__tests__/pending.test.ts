import {
  capturePendingReferral,
  peekPendingReferral,
  consumePendingReferral,
  PENDING_REF_KEY,
} from '../pending'

describe('pending referral capture/apply', () => {
  beforeEach(() => {
    window.localStorage.clear()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  describe('capturePendingReferral', () => {
    it('合法 ?ref 码写入 localStorage', () => {
      capturePendingReferral('?ref=alice_99')
      expect(peekPendingReferral()).toBe('alice_99')
      const raw = JSON.parse(window.localStorage.getItem(PENDING_REF_KEY)!)
      expect(raw.code).toBe('alice_99')
      expect(typeof raw.ts).toBe('number')
    })

    it('拒绝注入/非法字符的码（安全）', () => {
      capturePendingReferral('?ref=<script>alert(1)</script>')
      expect(peekPendingReferral()).toBeNull()
      capturePendingReferral('?ref=' + encodeURIComponent("a' OR 1=1"))
      expect(peekPendingReferral()).toBeNull()
    })

    it('拒绝过短/过长的码（2–64 字符）', () => {
      capturePendingReferral('?ref=a') // 1 字符
      expect(peekPendingReferral()).toBeNull()
      capturePendingReferral('?ref=' + 'x'.repeat(65)) // 65 字符
      expect(peekPendingReferral()).toBeNull()
    })

    it('无 ref 参数 → 不写入', () => {
      capturePendingReferral('?foo=bar')
      expect(peekPendingReferral()).toBeNull()
    })

    it('不覆盖已存在的有效 ref（首次捕获优先）', () => {
      capturePendingReferral('?ref=first_code')
      capturePendingReferral('?ref=second_code')
      expect(peekPendingReferral()).toBe('first_code')
    })

    it('过期 ref 可被新 ref 覆盖', () => {
      capturePendingReferral('?ref=old_code')
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000) // 31 天 > 30 天 TTL
      capturePendingReferral('?ref=new_code')
      expect(peekPendingReferral()).toBe('new_code')
    })
  })

  describe('peekPendingReferral — TTL', () => {
    it('30 天内有效', () => {
      capturePendingReferral('?ref=valid_code')
      jest.advanceTimersByTime(29 * 24 * 60 * 60 * 1000)
      expect(peekPendingReferral()).toBe('valid_code')
    })

    it('超过 30 天 → null（不返回过期码）', () => {
      capturePendingReferral('?ref=stale_code')
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
      expect(peekPendingReferral()).toBeNull()
    })

    it('损坏的 JSON → null（fail open，不崩）', () => {
      window.localStorage.setItem(PENDING_REF_KEY, 'not-json{{{')
      expect(peekPendingReferral()).toBeNull()
    })

    it('缺 ts 字段 → null', () => {
      window.localStorage.setItem(PENDING_REF_KEY, JSON.stringify({ code: 'x_y' }))
      expect(peekPendingReferral()).toBeNull()
    })
  })

  describe('peek vs consume', () => {
    it('peek 不消费（键仍在）', () => {
      capturePendingReferral('?ref=keep_me')
      expect(peekPendingReferral()).toBe('keep_me')
      expect(peekPendingReferral()).toBe('keep_me') // 二次 peek 仍在
      expect(window.localStorage.getItem(PENDING_REF_KEY)).not.toBeNull()
    })

    it('consume 返回码并删除键', () => {
      capturePendingReferral('?ref=use_once')
      expect(consumePendingReferral()).toBe('use_once')
      expect(window.localStorage.getItem(PENDING_REF_KEY)).toBeNull()
      expect(peekPendingReferral()).toBeNull() // 已消费
    })

    it('无 pending 时 consume → null（不崩）', () => {
      expect(consumePendingReferral()).toBeNull()
    })

    it('consume 过期 ref → null 但仍清键', () => {
      capturePendingReferral('?ref=expired_x')
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
      expect(consumePendingReferral()).toBeNull()
      expect(window.localStorage.getItem(PENDING_REF_KEY)).toBeNull()
    })
  })
})
