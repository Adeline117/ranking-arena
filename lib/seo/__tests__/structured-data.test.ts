import {
  generateWebSiteSchema,
  generateOrganizationSchema,
  generateTraderPersonSchema,
  generateBreadcrumbSchema,
  generateExchangeItemListSchema,
  schemaToJsonLd,
  combineSchemas,
  generateJsonLdMetadata,
} from '../structured-data'

describe('generateWebSiteSchema / generateOrganizationSchema', () => {
  it('WebSite schema @context/@type 正确', () => {
    const s = generateWebSiteSchema()
    expect(s['@context']).toBe('https://schema.org')
    expect(s['@type']).toBe('WebSite')
    expect(s.name).toBeTruthy()
    expect(s.url).toMatch(/^https?:\/\//)
  })

  it('Organization schema @type', () => {
    expect(generateOrganizationSchema()['@type']).toBe('Organization')
  })
})

describe('generateTraderPersonSchema', () => {
  it('Person @type + handle + URL 编码', () => {
    const s = generateTraderPersonSchema({ id: 't1', handle: 'crypto whale', source: 'binance' })
    expect(s['@type']).toBe('Person')
    expect(s.name).toBe('crypto whale')
    // handle 里的空格必须 URL 编码
    expect(s.url).toContain('crypto%20whale')
  })

  it('富描述：ROI 带符号 + 胜率 + 交易所', () => {
    const s = generateTraderPersonSchema({
      id: 't1',
      handle: 'x',
      roi90d: 45.678,
      winRate: 62.3,
      source: 'bybit',
    })
    expect(s.description).toContain('+45.68%')
    expect(s.description).toContain('62.3%')
    expect(s.description).toContain('Bybit') // 首字母大写
  })

  it('负 ROI 不加 +', () => {
    const s = generateTraderPersonSchema({ id: 't1', handle: 'x', roi90d: -20 })
    expect(s.description).toContain('-20.00%')
    expect(s.description).not.toContain('+-')
  })

  it('无数据 → 兜底描述', () => {
    const s = generateTraderPersonSchema({ id: 't1', handle: 'x' })
    expect(s.description).toContain('Crypto trader')
  })

  it('profileUrl → sameAs', () => {
    const s = generateTraderPersonSchema({
      id: 't1',
      handle: 'x',
      profileUrl: 'https://binance.com/x',
    })
    expect(s.sameAs).toEqual(['https://binance.com/x'])
  })
})

describe('generateBreadcrumbSchema', () => {
  it('position 从 1 递增', () => {
    const s = generateBreadcrumbSchema([
      { name: 'Home', url: 'https://x.com' },
      { name: 'Rankings', url: 'https://x.com/r' },
      { name: 'Trader' },
    ])
    expect(s['@type']).toBe('BreadcrumbList')
    expect(s.itemListElement[0].position).toBe(1)
    expect(s.itemListElement[2].position).toBe(3)
  })

  it('无 url 的项不含 item 字段', () => {
    const s = generateBreadcrumbSchema([{ name: 'Current' }])
    expect(s.itemListElement[0]).not.toHaveProperty('item')
  })
})

describe('generateExchangeItemListSchema', () => {
  it('ItemList + numberOfItems + position', () => {
    const s = generateExchangeItemListSchema({
      name: 'Binance',
      slug: 'binance',
      sourceType: 'CEX',
      traderCount: 5000,
      topTraders: [{ handle: 'a', arenaScore: 88.6, roi: 120 }, { handle: 'b' }],
    }) as Record<string, unknown>
    expect(s['@type']).toBe('ItemList')
    expect(s.numberOfItems).toBe(5000)
    const items = s.itemListElement as Array<Record<string, unknown>>
    expect(items[0].position).toBe(1)
    expect(items[0].description).toContain('Arena Score: 89') // Math.round
    expect(items[1]).not.toHaveProperty('description') // 无 arenaScore
  })
})

describe('schemaToJsonLd / combineSchemas / generateJsonLdMetadata', () => {
  it('schemaToJsonLd 产出合法可解析 JSON', () => {
    const json = schemaToJsonLd(generateWebSiteSchema())
    expect(() => JSON.parse(json)).not.toThrow()
    expect(JSON.parse(json)['@type']).toBe('WebSite')
  })

  it('combineSchemas → 数组', () => {
    const arr = combineSchemas({ a: 1 }, { b: 2 })
    expect(arr).toHaveLength(2)
  })

  it('generateJsonLdMetadata → Next.js script 结构', () => {
    const m = generateJsonLdMetadata(generateWebSiteSchema())
    expect(m.script[0].type).toBe('application/ld+json')
    expect(() => JSON.parse(m.script[0].text)).not.toThrow()
  })
})
