import {
  getLevelInfo,
  getExpForAction,
  getExpActionLabel,
  LEVELS,
  EXP_ACTIONS,
} from '../user-level'

describe('getLevelInfo', () => {
  it('exp=0 → level 1 (磷虾), progress 从 0 起', () => {
    const info = getLevelInfo(0)
    expect(info.level).toBe(1)
    expect(info.nameEn).toBe('Krill')
    expect(info.currentExp).toBe(0)
    expect(info.nextExp).toBe(500)
    expect(info.progress).toBe(0)
  })

  it('落在等级区间中点 → progress ≈ 50', () => {
    // level 1: [0,500) → 250 是中点
    expect(getLevelInfo(250).progress).toBe(50)
  })

  it('恰好达到下一级门槛 → 升级', () => {
    expect(getLevelInfo(500).level).toBe(2)
    expect(getLevelInfo(2000).level).toBe(3)
    expect(getLevelInfo(10000).level).toBe(4)
    expect(getLevelInfo(50000).level).toBe(5)
  })

  it('门槛前一点 → 仍是低一级', () => {
    expect(getLevelInfo(499).level).toBe(1)
    expect(getLevelInfo(1999).level).toBe(2)
  })

  it('顶级(虎鲸) → nextExp=null, progress=100', () => {
    const info = getLevelInfo(999999)
    expect(info.level).toBe(5)
    expect(info.nextExp).toBeNull()
    expect(info.progress).toBe(100)
  })

  it('progress 永不超过 100（clamp）', () => {
    // 接近下一级门槛
    expect(getLevelInfo(499).progress).toBeLessThanOrEqual(100)
    expect(getLevelInfo(9999).progress).toBeLessThanOrEqual(100)
  })

  it('progress 是整数（Math.floor）', () => {
    const p = getLevelInfo(333).progress
    expect(Number.isInteger(p)).toBe(true)
  })
})

describe('getExpForAction', () => {
  it('未知 action → 0', () => {
    expect(getExpForAction('nonexistent', 0)).toBe(0)
  })

  it('无日上限(dailyLimit=null) → 恒返回满额 exp', () => {
    // liked: exp 3, dailyLimit null
    expect(getExpForAction('liked', 0)).toBe(3)
    expect(getExpForAction('liked', 99999)).toBe(3)
  })

  it('未达上限 → 满额', () => {
    // login: exp 5, dailyLimit 5
    expect(getExpForAction('login', 0)).toBe(5)
  })

  it('已达/超过上限 → 0', () => {
    expect(getExpForAction('login', 5)).toBe(0)
    expect(getExpForAction('login', 10)).toBe(0)
  })

  it('接近上限 → 返回剩余额度（min(exp, remaining)）', () => {
    // post: exp 15, dailyLimit 60；已得 55 → 剩 5 → 返回 5
    expect(getExpForAction('post', 55)).toBe(5)
    // 已得 50 → 剩 10 → min(15,10)=10
    expect(getExpForAction('post', 50)).toBe(10)
    // 已得 40 → 剩 20 → min(15,20)=15
    expect(getExpForAction('post', 40)).toBe(15)
  })
})

describe('getExpActionLabel（锁住历史 bug：原始 key 曾泄露给用户）', () => {
  // t() 返回带 key 的可辨识字符串，验证查的是正确的 i18n key
  const t = (k: string) => `T[${k}]`

  it('snake_case key → 正确的 camelCase i18n key（read_checkin → expActionReadCheckin）', () => {
    expect(getExpActionLabel('read_checkin', t)).toBe('T[expActionReadCheckin]')
  })

  it('单词 key → 首字母大写（login → expActionLogin）', () => {
    expect(getExpActionLabel('login', t)).toBe('T[expActionLogin]')
  })

  it('多下划线 key 正确转换（purchase_annual → expActionPurchaseAnnual）', () => {
    expect(getExpActionLabel('purchase_annual', t)).toBe('T[expActionPurchaseAnnual]')
  })

  it('t() 未命中(返回空) → 回退到原始 key（不崩、不显示空）', () => {
    const emptyT = () => ''
    expect(getExpActionLabel('login', emptyT)).toBe('login')
  })
})

describe('数据完整性', () => {
  it('LEVELS 的 minExp 严格递增', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].minExp).toBeGreaterThan(LEVELS[i - 1].minExp)
    }
  })

  it('LEVELS 的 level 从 1 连续递增', () => {
    LEVELS.forEach((l, i) => expect(l.level).toBe(i + 1))
  })

  it('EXP_ACTIONS 每个 key 唯一', () => {
    const keys = EXP_ACTIONS.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
