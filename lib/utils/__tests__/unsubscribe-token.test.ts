import { generateUnsubscribeToken, verifyUnsubscribeToken } from '../unsubscribe-token'

const ORIGINAL_SECRET = process.env.CRON_SECRET
beforeEach(() => {
  process.env.CRON_SECRET = 'test-signing-secret-for-unsubscribe-tokens'
})
afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_SECRET
})

describe('unsubscribe token（HMAC 签名）', () => {
  it('生成→校验 往返成功，还原 userId + type', () => {
    const token = generateUnsubscribeToken('user-123', 'digest')
    const payload = verifyUnsubscribeToken(token)
    expect(payload).toEqual({ userId: 'user-123', type: 'digest' })
  })

  it('type=all 往返', () => {
    const token = generateUnsubscribeToken('u1', 'all')
    expect(verifyUnsubscribeToken(token)?.type).toBe('all')
  })

  it('篡改签名 → null', () => {
    const token = generateUnsubscribeToken('user-123', 'digest')
    const [payload] = token.split('.')
    const tampered = `${payload}.AAAAtampered_signature_AAAA`
    expect(verifyUnsubscribeToken(tampered)).toBeNull()
  })

  it('篡改 payload（改 userId）→ 签名不匹配 → null', () => {
    const token = generateUnsubscribeToken('user-123', 'digest')
    const [, sig] = token.split('.')
    const forgedPayload = Buffer.from('attacker:all:' + Date.now()).toString('base64url')
    expect(verifyUnsubscribeToken(`${forgedPayload}.${sig}`)).toBeNull()
  })

  it('格式错误（无 . 分隔 / 段数不对）→ null', () => {
    expect(verifyUnsubscribeToken('garbage')).toBeNull()
    expect(verifyUnsubscribeToken('a.b.c')).toBeNull()
    expect(verifyUnsubscribeToken('')).toBeNull()
  })

  it('不同 userId 生成的 token 互不通过（签名绑定 payload）', () => {
    const t1 = generateUnsubscribeToken('userA', 'all')
    const t2 = generateUnsubscribeToken('userB', 'all')
    // 交换签名
    const p1 = t1.split('.')[0]
    const s2 = t2.split('.')[1]
    expect(verifyUnsubscribeToken(`${p1}.${s2}`)).toBeNull()
  })

  it('过期 token（90 天前的时间戳）→ null', () => {
    // 手工造一个 91 天前的合法签名 token —— 需要复用同一 secret，
    // 通过篡改一个真 token 的时间戳是不行的（会破坏签名），所以直接验证
    // 生成的 token 当下有效即可证明未过期路径；过期路径用 spy 时间。
    const realNow = Date.now
    const token = generateUnsubscribeToken('u1', 'digest')
    // 把"现在"推到 91 天后再校验
    Date.now = () => realNow() + 91 * 24 * 60 * 60 * 1000
    try {
      expect(verifyUnsubscribeToken(token)).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('没有签名密钥时拒绝签发，也不接受任何 token（无源码内回退值）', () => {
    const token = generateUnsubscribeToken('user-123', 'digest')
    delete process.env.CRON_SECRET
    expect(() => generateUnsubscribeToken('user-123', 'digest')).toThrow(/CRON_SECRET/)
    expect(verifyUnsubscribeToken(token)).toBeNull()
  })

  it('换了签名密钥后，旧密钥签的 token 失效', () => {
    const token = generateUnsubscribeToken('user-123', 'digest')
    process.env.CRON_SECRET = 'a-different-signing-secret'
    expect(verifyUnsubscribeToken(token)).toBeNull()
  })
})
