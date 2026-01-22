/**
 * Zod Schemas Tests
 * 测试 Zod 类型定义和验证
 */

import {
  UUIDSchema,
  ExchangeSchema,
  TimeRangeSchema,
  SortOrderSchema,
  TraderProfileSchema,
  TraderPerformanceSchema,
  RankedTraderSchema,
  PostSchema,
  CreatePostInputSchema,
  PostListOptionsSchema,
  CommentSchema,
  CreateCommentInputSchema,
  PaginationSchema,
  createSuccessResponseSchema,
  ApiErrorResponseSchema,
  RiskMetricsSchema,
  UserProfileSchema,
  UpdateProfileInputSchema,
  safeParse,
  validate,
  createResponseValidator,
} from './index'
import { z } from 'zod'

describe('UUIDSchema', () => {
  test('should validate valid UUID', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(() => UUIDSchema.parse(uuid)).not.toThrow()
  })

  test('should reject invalid UUID', () => {
    expect(() => UUIDSchema.parse('invalid')).toThrow()
  })
})

describe('ExchangeSchema', () => {
  test('should validate valid exchanges', () => {
    expect(() => ExchangeSchema.parse('binance')).not.toThrow()
    expect(() => ExchangeSchema.parse('bybit')).not.toThrow()
    expect(() => ExchangeSchema.parse('bitget')).not.toThrow()
  })

  test('should reject invalid exchange', () => {
    expect(() => ExchangeSchema.parse('invalid_exchange')).toThrow()
  })
})

describe('TimeRangeSchema', () => {
  test('should validate valid time ranges', () => {
    expect(() => TimeRangeSchema.parse('7D')).not.toThrow()
    expect(() => TimeRangeSchema.parse('30D')).not.toThrow()
    expect(() => TimeRangeSchema.parse('90D')).not.toThrow()
    expect(() => TimeRangeSchema.parse('1Y')).not.toThrow()
    expect(() => TimeRangeSchema.parse('2Y')).not.toThrow()
    expect(() => TimeRangeSchema.parse('All')).not.toThrow()
  })

  test('should reject invalid time range', () => {
    expect(() => TimeRangeSchema.parse('invalid')).toThrow()
  })
})

describe('SortOrderSchema', () => {
  test('should validate sort orders', () => {
    expect(() => SortOrderSchema.parse('asc')).not.toThrow()
    expect(() => SortOrderSchema.parse('desc')).not.toThrow()
  })

  test('should reject invalid sort order', () => {
    expect(() => SortOrderSchema.parse('invalid')).toThrow()
  })
})

describe('TraderProfileSchema', () => {
  test('should validate valid trader profile', () => {
    const profile = {
      id: 'trader123',
      handle: 'testTrader',
      bio: 'Test bio',
      followers: 100,
    }
    expect(() => TraderProfileSchema.parse(profile)).not.toThrow()
  })

  test('should allow optional fields', () => {
    const profile = {
      id: 'trader123',
      handle: 'testTrader',
    }
    expect(() => TraderProfileSchema.parse(profile)).not.toThrow()
  })

  test('should reject negative followers', () => {
    const profile = {
      id: 'trader123',
      handle: 'testTrader',
      followers: -1,
    }
    expect(() => TraderProfileSchema.parse(profile)).toThrow()
  })
})

describe('TraderPerformanceSchema', () => {
  test('should validate valid performance data', () => {
    const performance = {
      roi_7d: 10.5,
      roi_30d: 25.3,
      roi_90d: 50.0,
      win_rate: 65.5,
      max_drawdown: -15.0,
    }
    expect(() => TraderPerformanceSchema.parse(performance)).not.toThrow()
  })

  test('should reject win_rate over 100', () => {
    const performance = {
      win_rate: 150,
    }
    expect(() => TraderPerformanceSchema.parse(performance)).toThrow()
  })

  test('should reject negative win_rate', () => {
    const performance = {
      win_rate: -10,
    }
    expect(() => TraderPerformanceSchema.parse(performance)).toThrow()
  })
})

describe('RankedTraderSchema', () => {
  test('should validate valid ranked trader', () => {
    const trader = {
      id: 'trader123',
      handle: 'testTrader',
      roi: 50.0,
      followers: 100,
      source: 'binance',
    }
    expect(() => RankedTraderSchema.parse(trader)).not.toThrow()
  })

  test('should default followers to 0', () => {
    const trader = {
      id: 'trader123',
      handle: 'testTrader',
      roi: 50.0,
      source: 'binance',
    }
    const result = RankedTraderSchema.parse(trader)
    expect(result.followers).toBe(0)
  })
})

describe('PostSchema', () => {
  test('should validate valid post', () => {
    const post = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Post',
      author_id: '123e4567-e89b-12d3-a456-426614174000',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => PostSchema.parse(post)).not.toThrow()
  })

  test('should reject empty title', () => {
    const post = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: '',
      author_id: '123e4567-e89b-12d3-a456-426614174000',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => PostSchema.parse(post)).toThrow()
  })

  test('should reject title exceeding max length', () => {
    const post = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'A'.repeat(201),
      author_id: '123e4567-e89b-12d3-a456-426614174000',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => PostSchema.parse(post)).toThrow()
  })
})

describe('CreatePostInputSchema', () => {
  test('should validate valid input', () => {
    const input = {
      title: 'Test Post',
      content: 'Test content',
    }
    expect(() => CreatePostInputSchema.parse(input)).not.toThrow()
  })

  test('should trim whitespace', () => {
    const input = {
      title: '  Test Post  ',
      content: '  Test content  ',
    }
    const result = CreatePostInputSchema.parse(input)
    expect(result.title).toBe('Test Post')
    expect(result.content).toBe('Test content')
  })

  test('should reject empty title', () => {
    const input = {
      title: '',
    }
    expect(() => CreatePostInputSchema.parse(input)).toThrow()
  })

  test('should validate image URLs', () => {
    const input = {
      title: 'Test Post',
      images: ['https://example.com/image.png'],
    }
    expect(() => CreatePostInputSchema.parse(input)).not.toThrow()
  })

  test('should reject invalid image URLs', () => {
    const input = {
      title: 'Test Post',
      images: ['not-a-url'],
    }
    expect(() => CreatePostInputSchema.parse(input)).toThrow()
  })

  test('should limit images to 9', () => {
    const input = {
      title: 'Test Post',
      images: Array(10).fill('https://example.com/image.png'),
    }
    expect(() => CreatePostInputSchema.parse(input)).toThrow()
  })

  test('should validate poll options', () => {
    const input = {
      title: 'Test Post',
      poll_options: ['Option 1', 'Option 2'],
    }
    expect(() => CreatePostInputSchema.parse(input)).not.toThrow()
  })

  test('should require at least 2 poll options', () => {
    const input = {
      title: 'Test Post',
      poll_options: ['Only one'],
    }
    expect(() => CreatePostInputSchema.parse(input)).toThrow()
  })
})

describe('PostListOptionsSchema', () => {
  test('should provide defaults', () => {
    const result = PostListOptionsSchema.parse({})
    expect(result.limit).toBe(20)
    expect(result.offset).toBe(0)
    expect(result.sort_by).toBe('created_at')
    expect(result.sort_order).toBe('desc')
  })

  test('should reject limit over 100', () => {
    expect(() => PostListOptionsSchema.parse({ limit: 101 })).toThrow()
  })

  test('should reject negative offset', () => {
    expect(() => PostListOptionsSchema.parse({ offset: -1 })).toThrow()
  })
})

describe('CommentSchema', () => {
  test('should validate valid comment', () => {
    const comment = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      post_id: '123e4567-e89b-12d3-a456-426614174000',
      author_id: '123e4567-e89b-12d3-a456-426614174000',
      content: 'Test comment',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => CommentSchema.parse(comment)).not.toThrow()
  })
})

describe('CreateCommentInputSchema', () => {
  test('should validate valid input', () => {
    const input = {
      post_id: '123e4567-e89b-12d3-a456-426614174000',
      content: 'Test comment',
    }
    expect(() => CreateCommentInputSchema.parse(input)).not.toThrow()
  })

  test('should trim content', () => {
    const input = {
      post_id: '123e4567-e89b-12d3-a456-426614174000',
      content: '  Test comment  ',
    }
    const result = CreateCommentInputSchema.parse(input)
    expect(result.content).toBe('Test comment')
  })

  test('should reject empty content', () => {
    const input = {
      post_id: '123e4567-e89b-12d3-a456-426614174000',
      content: '',
    }
    expect(() => CreateCommentInputSchema.parse(input)).toThrow()
  })

  test('should reject content exceeding max length', () => {
    const input = {
      post_id: '123e4567-e89b-12d3-a456-426614174000',
      content: 'A'.repeat(2001),
    }
    expect(() => CreateCommentInputSchema.parse(input)).toThrow()
  })
})

describe('PaginationSchema', () => {
  test('should validate valid pagination', () => {
    const pagination = {
      limit: 20,
      offset: 0,
      has_more: true,
      total: 100,
    }
    expect(() => PaginationSchema.parse(pagination)).not.toThrow()
  })
})

describe('ApiErrorResponseSchema', () => {
  test('should validate error response', () => {
    const error = {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        timestamp: '2024-01-01T00:00:00Z',
      },
    }
    expect(() => ApiErrorResponseSchema.parse(error)).not.toThrow()
  })
})

describe('RiskMetricsSchema', () => {
  test('should validate risk metrics', () => {
    const metrics = {
      sharpeRatio: 1.5,
      sortinoRatio: 2.0,
      calmarRatio: 1.2,
      volatility: 0.15,
      downwardVolatility: 0.10,
      maxDrawdown: -0.20,
      maxDrawdownDuration: 30,
      maxConsecutiveLosses: 5,
      maxConsecutiveWins: 10,
      profitLossRatio: 1.8,
      rewardRiskRatio: 2.5,
      riskLevel: 3,
      riskLevelDescription: 'Medium',
    }
    expect(() => RiskMetricsSchema.parse(metrics)).not.toThrow()
  })

  test('should allow null values', () => {
    const metrics = {
      sharpeRatio: null,
      sortinoRatio: null,
      calmarRatio: null,
      volatility: null,
      downwardVolatility: null,
      maxDrawdown: null,
      maxDrawdownDuration: null,
      maxConsecutiveLosses: null,
      maxConsecutiveWins: null,
      profitLossRatio: null,
      rewardRiskRatio: null,
      riskLevel: 1,
      riskLevelDescription: 'Very Low',
    }
    expect(() => RiskMetricsSchema.parse(metrics)).not.toThrow()
  })

  test('should validate risk level range', () => {
    expect(() => RiskMetricsSchema.parse({ riskLevel: 0, riskLevelDescription: 'Invalid' })).toThrow()
    expect(() => RiskMetricsSchema.parse({ riskLevel: 6, riskLevelDescription: 'Invalid' })).toThrow()
  })
})

describe('UserProfileSchema', () => {
  test('should validate user profile', () => {
    const profile = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      handle: 'testuser',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => UserProfileSchema.parse(profile)).not.toThrow()
  })

  test('should reject short handle', () => {
    const profile = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      handle: 'ab',
      created_at: '2024-01-01T00:00:00Z',
    }
    expect(() => UserProfileSchema.parse(profile)).toThrow()
  })
})

describe('UpdateProfileInputSchema', () => {
  test('should validate update input', () => {
    const input = {
      display_name: 'New Name',
      bio: 'New bio',
    }
    expect(() => UpdateProfileInputSchema.parse(input)).not.toThrow()
  })

  test('should allow all optional fields', () => {
    expect(() => UpdateProfileInputSchema.parse({})).not.toThrow()
  })
})

describe('safeParse', () => {
  test('should return parsed data on success', () => {
    const schema = z.object({ name: z.string() })
    const result = safeParse(schema, { name: 'Test' }, { name: 'Default' })
    expect(result.name).toBe('Test')
  })

  test('should return default on failure', () => {
    const schema = z.object({ name: z.string() })
    const result = safeParse(schema, { name: 123 }, { name: 'Default' })
    expect(result.name).toBe('Default')
  })
})

describe('validate', () => {
  test('should return parsed data on success', () => {
    const schema = z.object({ name: z.string() })
    const result = validate(schema, { name: 'Test' })
    expect(result.name).toBe('Test')
  })

  test('should throw on failure', () => {
    const schema = z.object({ name: z.string() })
    expect(() => validate(schema, { name: 123 })).toThrow()
  })

  test('should include context in error message', () => {
    const schema = z.object({ name: z.string() })
    expect(() => validate(schema, { name: 123 }, 'TestContext')).toThrow('[TestContext]')
  })
})

describe('createResponseValidator', () => {
  test('should validate success response', () => {
    const validator = createResponseValidator(z.object({ id: z.string() }))
    const response = {
      success: true,
      data: { id: 'test123' },
    }
    const result = validator(response)
    expect(result.data.id).toBe('test123')
  })

  test('should throw on error response', () => {
    const validator = createResponseValidator(z.object({ id: z.string() }))
    const response = {
      success: false,
      error: {
        code: 'ERROR',
        message: 'Something went wrong',
        timestamp: '2024-01-01T00:00:00Z',
      },
    }
    expect(() => validator(response)).toThrow('Something went wrong')
  })
})

describe('createSuccessResponseSchema', () => {
  test('should create valid response schema', () => {
    const schema = createSuccessResponseSchema(z.object({ id: z.string() }))
    const response = {
      success: true,
      data: { id: 'test123' },
    }
    expect(() => schema.parse(response)).not.toThrow()
  })

  test('should allow meta field', () => {
    const schema = createSuccessResponseSchema(z.object({ id: z.string() }))
    const response = {
      success: true,
      data: { id: 'test123' },
      meta: {
        pagination: {
          limit: 20,
          offset: 0,
          has_more: true,
        },
      },
    }
    expect(() => schema.parse(response)).not.toThrow()
  })
})
