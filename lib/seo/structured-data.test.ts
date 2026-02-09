/**
 * Structured Data Tests
 * 测试 JSON-LD 结构化数据生成器
 */

import {
  generateWebSiteSchema,
  generateOrganizationSchema,
  generateTraderPersonSchema,
  generateTraderProfilePageSchema,
  generatePostArticleSchema,
  generateBreadcrumbSchema,
  schemaToJsonLd,
  combineSchemas,
  generateJsonLdMetadata,
} from './structured-data'

describe('generateWebSiteSchema', () => {
  test('should generate valid WebSite schema', () => {
    const schema = generateWebSiteSchema()

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('WebSite')
    expect(schema.name).toBe('Arena')
    expect(schema.url).toBeDefined()
  })

  test('should include search action', () => {
    const schema = generateWebSiteSchema()

    expect(schema.potentialAction).toBeDefined()
    expect(schema.potentialAction?.['@type']).toBe('SearchAction')
    expect(schema.potentialAction?.target.urlTemplate).toContain('search')
  })

  test('should include publisher info', () => {
    const schema = generateWebSiteSchema()

    expect(schema.publisher).toBeDefined()
    expect(schema.publisher?.['@type']).toBe('Organization')
  })
})

describe('generateOrganizationSchema', () => {
  test('should generate valid Organization schema', () => {
    const schema = generateOrganizationSchema()

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('Organization')
    expect(schema.name).toBe('Arena')
    expect(schema.url).toBeDefined()
    expect(schema.logo).toBeDefined()
  })

  test('should include contact point', () => {
    const schema = generateOrganizationSchema()

    expect(schema.contactPoint).toBeDefined()
    expect(schema.contactPoint?.['@type']).toBe('ContactPoint')
    expect(schema.contactPoint?.contactType).toBe('customer service')
  })
})

describe('generateTraderPersonSchema', () => {
  test('should generate valid Person schema', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
    }

    const schema = generateTraderPersonSchema(trader)

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('Person')
    expect(schema.name).toBe('testTrader')
    expect(schema.identifier).toBe('trader123')
    expect(schema.jobTitle).toBe('Crypto Trader')
  })

  test('should include avatar when provided', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
      avatarUrl: 'https://example.com/avatar.png',
    }

    const schema = generateTraderPersonSchema(trader)
    expect(schema.image).toBe('https://example.com/avatar.png')
  })

  test('should include bio as description', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
      bio: 'Professional crypto trader',
    }

    const schema = generateTraderPersonSchema(trader)
    expect(schema.description).toBe('Professional crypto trader')
  })

  test('should include profile URL as sameAs', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
      profileUrl: 'https://binance.com/trader/testTrader',
    }

    const schema = generateTraderPersonSchema(trader)
    expect(schema.sameAs).toContain('https://binance.com/trader/testTrader')
  })

  test('should generate trader URL', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
    }

    const schema = generateTraderPersonSchema(trader)
    expect(schema.url).toContain('/trader/testTrader')
  })
})

describe('generateTraderProfilePageSchema', () => {
  test('should generate valid ProfilePage schema', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
    }

    const schema = generateTraderProfilePageSchema(trader)

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('ProfilePage')
    expect(schema.mainEntity['@type']).toBe('Person')
    expect(schema.name).toContain('testTrader')
  })

  test('should include date modified', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
    }
    const lastModified = '2024-01-01T00:00:00Z'

    const schema = generateTraderProfilePageSchema(trader, lastModified)
    expect(schema.dateModified).toBe(lastModified)
  })

  test('should generate description', () => {
    const trader = {
      handle: 'testTrader',
      id: 'trader123',
      bio: 'Custom bio',
    }

    const schema = generateTraderProfilePageSchema(trader)
    expect(schema.description).toBe('Custom bio')
  })
})

describe('generatePostArticleSchema', () => {
  test('should generate valid Article schema', () => {
    const post = {
      id: 'post123',
      title: 'Test Post Title',
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
    }

    const schema = generatePostArticleSchema(post)

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('DiscussionForumPosting')
    expect(schema.headline).toBe('Test Post Title')
    expect(schema.datePublished).toBe('2024-01-01T00:00:00Z')
  })

  test('should truncate long headlines', () => {
    const post = {
      id: 'post123',
      title: 'A'.repeat(200), // Very long title
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.headline.length).toBeLessThanOrEqual(110)
  })

  test('should include author info', () => {
    const post = {
      id: 'post123',
      title: 'Test Post',
      authorHandle: 'testUser',
      authorAvatarUrl: 'https://example.com/avatar.png',
      createdAt: '2024-01-01T00:00:00Z',
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.author.name).toBe('testUser')
    expect(schema.author.image).toBe('https://example.com/avatar.png')
  })

  test('should include interaction statistics', () => {
    const post = {
      id: 'post123',
      title: 'Test Post',
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
      likeCount: 100,
      viewCount: 1000,
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.interactionStatistic).toBeDefined()
    expect(schema.interactionStatistic?.length).toBe(2)
  })

  test('should include comment count', () => {
    const post = {
      id: 'post123',
      title: 'Test Post',
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
      commentCount: 50,
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.commentCount).toBe(50)
  })

  test('should include images', () => {
    const post = {
      id: 'post123',
      title: 'Test Post',
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
      images: ['https://example.com/image1.png', 'https://example.com/image2.png'],
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.image).toEqual(['https://example.com/image1.png', 'https://example.com/image2.png'])
  })

  test('should include publisher', () => {
    const post = {
      id: 'post123',
      title: 'Test Post',
      authorHandle: 'testUser',
      createdAt: '2024-01-01T00:00:00Z',
    }

    const schema = generatePostArticleSchema(post)
    expect(schema.publisher?.['@type']).toBe('Organization')
  })
})

describe('generateBreadcrumbSchema', () => {
  test('should generate valid BreadcrumbList schema', () => {
    const items = [
      { name: 'Home', url: 'https://example.com' },
      { name: 'Traders', url: 'https://example.com/traders' },
      { name: 'Test Trader' },
    ]

    const schema = generateBreadcrumbSchema(items)

    expect(schema['@context']).toBe('https://schema.org')
    expect(schema['@type']).toBe('BreadcrumbList')
    expect(schema.itemListElement).toHaveLength(3)
  })

  test('should set correct positions', () => {
    const items = [
      { name: 'Home', url: 'https://example.com' },
      { name: 'About' },
    ]

    const schema = generateBreadcrumbSchema(items)

    expect(schema.itemListElement[0].position).toBe(1)
    expect(schema.itemListElement[1].position).toBe(2)
  })

  test('should include item URL when provided', () => {
    const items = [
      { name: 'Home', url: 'https://example.com' },
    ]

    const schema = generateBreadcrumbSchema(items)
    expect(schema.itemListElement[0].item).toBe('https://example.com')
  })

  test('should not include item URL when not provided', () => {
    const items = [
      { name: 'Current Page' },
    ]

    const schema = generateBreadcrumbSchema(items)
    expect(schema.itemListElement[0].item).toBeUndefined()
  })
})

describe('schemaToJsonLd', () => {
  test('should convert schema to JSON string', () => {
    const schema = { '@type': 'WebSite', name: 'Test' }
    const result = schemaToJsonLd(schema)

    expect(result).toBe(JSON.stringify(schema))
  })

  test('should handle array of schemas', () => {
    const schemas = [
      { '@type': 'WebSite', name: 'Test' },
      { '@type': 'Organization', name: 'Org' },
    ]
    const result = schemaToJsonLd(schemas)

    expect(result).toBe(JSON.stringify(schemas))
  })
})

describe('combineSchemas', () => {
  test('should combine multiple schemas into array', () => {
    const schema1 = { '@type': 'WebSite', name: 'Test' }
    const schema2 = { '@type': 'Organization', name: 'Org' }

    const result = combineSchemas(schema1, schema2)

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(schema1)
    expect(result[1]).toBe(schema2)
  })
})

describe('generateJsonLdMetadata', () => {
  test('should generate metadata object for Next.js', () => {
    const schema = { '@type': 'WebSite', name: 'Test' }
    const result = generateJsonLdMetadata(schema)

    expect(result.script).toBeDefined()
    expect(result.script[0].type).toBe('application/ld+json')
    expect(result.script[0].text).toBe(JSON.stringify(schema))
  })
})
