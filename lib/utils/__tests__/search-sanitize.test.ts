import { isMaliciousSearchQuery } from '../search-sanitize'

describe('isMaliciousSearchQuery — 拦截恶意', () => {
  it('空查询 → true（拦截）', () => {
    expect(isMaliciousSearchQuery('')).toBe(true)
  })

  it('SQL 注入 → true', () => {
    expect(isMaliciousSearchQuery("'; DROP TABLE users; --")).toBe(true)
    expect(isMaliciousSearchQuery('1 OR 1=1')).toBe(true)
    expect(isMaliciousSearchQuery('UNION SELECT password')).toBe(true)
    expect(isMaliciousSearchQuery('admin/*comment*/')).toBe(true)
  })

  it('XSS → true', () => {
    expect(isMaliciousSearchQuery('<script>alert(1)</script>')).toBe(true)
    expect(isMaliciousSearchQuery('javascript:alert(1)')).toBe(true)
    expect(isMaliciousSearchQuery('<img src=x onerror=alert(1)>')).toBe(true)
    expect(isMaliciousSearchQuery('<svg onload=alert(1)>')).toBe(true)
  })

  it('命令注入 → true', () => {
    expect(isMaliciousSearchQuery('cat /etc/passwd | grep root')).toBe(true)
    expect(isMaliciousSearchQuery('foo && rm -rf /')).toBe(true)
    expect(isMaliciousSearchQuery('$(whoami)')).toBe(true)
  })

  it('过多特殊字符 → true', () => {
    expect(isMaliciousSearchQuery('!@#%^&*()+={}[]~')).toBe(true)
  })
})

describe('isMaliciousSearchQuery — 放行合法搜索', () => {
  it('普通币名/交易员名 → false', () => {
    expect(isMaliciousSearchQuery('bitcoin')).toBe(false)
    expect(isMaliciousSearchQuery('BTC trader')).toBe(false)
    expect(isMaliciousSearchQuery('vitalik.eth')).toBe(false)
    expect(isMaliciousSearchQuery('ETH/USDT')).toBe(false) // 斜杠在允许集
    expect(isMaliciousSearchQuery('@satoshi')).toBe(false)
  })

  it('CJK/非 ASCII 合法搜索 → false（2026-07-03 修：曾因 ASCII-only 正则误杀全部中日韩搜索）', () => {
    expect(isMaliciousSearchQuery('聪明的交易员')).toBe(false)
    expect(isMaliciousSearchQuery('ビットコイン')).toBe(false) // 日文
    expect(isMaliciousSearchQuery('비트코인')).toBe(false) // 韩文
    expect(isMaliciousSearchQuery('криптовалюта')).toBe(false) // 俄文
  })

  it('含 # $ - . _ 的合法词 → false', () => {
    expect(isMaliciousSearchQuery('top-100')).toBe(false)
    expect(isMaliciousSearchQuery('#defi')).toBe(false)
    expect(isMaliciousSearchQuery('user_name')).toBe(false)
  })
})

describe('isMaliciousSearchQuery — 已知误杀（保守安全策略的代价，记录当前行为）', () => {
  it('"price drop" 因 \\bdrop\\b 被误判为恶意（SQL drop 关键词）', () => {
    // 这是安全过滤的保守 false-positive：合法搜索被拦。
    // 记录当前行为——若要放行需精细化 SQL 模式（改动有安全风险，留待评估）。
    expect(isMaliciousSearchQuery('price drop')).toBe(true)
  })
})
