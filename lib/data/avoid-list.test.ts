/**
 * Avoid List Data Layer Tests
 * 测试避雷榜数据层
 */

import {
  getAvoidList,
  getTraderAvoidScore,
  getTraderAvoidVotes,
  hasUserVoted,
  getUserAvoidVote,
  createAvoidVote,
  updateAvoidVote,
  deleteAvoidVote,
} from './avoid-list'

// Create mock Supabase client
const createMockSupabase = () => {
  const mockClient: Record<string, jest.Mock> = {
    from: jest.fn(),
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  }

  // Chain all methods to return the client
  Object.keys(mockClient).forEach(key => {
    mockClient[key].mockReturnValue(mockClient)
  })

  return mockClient
}

describe('getAvoidList', () => {
  test('should return empty array when no data found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    const result = await getAvoidList(mockSupabase as any)
    expect(result).toEqual([])
  })

  test('should throw error on database error', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: null, error: new Error('DB Error') })

    await expect(getAvoidList(mockSupabase as any)).rejects.toThrow()
  })

  test('should query correct table', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    await getAvoidList(mockSupabase as any)

    expect(mockSupabase.from).toHaveBeenCalledWith('trader_avoid_scores')
  })
})

describe('getTraderAvoidScore', () => {
  test('should return null when no score found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getTraderAvoidScore(mockSupabase as any, 'trader1', 'binance')
    expect(result).toBeNull()
  })

  test('should return avoid score when found', async () => {
    const mockSupabase = createMockSupabase()
    const mockScore = {
      trader_id: 'trader1',
      source: 'binance',
      avoid_count: 5,
      high_drawdown_count: 2,
    }

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: mockScore, error: null })

    const result = await getTraderAvoidScore(mockSupabase as any, 'trader1', 'binance')
    expect(result).not.toBeNull()
    expect(result?.avoid_count).toBe(5)
  })

  test('should query with correct parameters', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await getTraderAvoidScore(mockSupabase as any, 'trader123', 'bybit')

    expect(mockSupabase.from).toHaveBeenCalledWith('trader_avoid_scores')
    expect(mockSupabase.eq).toHaveBeenCalledWith('trader_id', 'trader123')
    expect(mockSupabase.eq).toHaveBeenCalledWith('source', 'bybit')
  })
})

describe('getTraderAvoidVotes', () => {
  test('should return empty array when no votes found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    const result = await getTraderAvoidVotes(mockSupabase as any, 'trader1', 'binance')
    expect(result).toEqual([])
  })

  test('should query correct table', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.range.mockResolvedValueOnce({ data: [], error: null })

    await getTraderAvoidVotes(mockSupabase as any, 'trader123', 'binance')

    expect(mockSupabase.from).toHaveBeenCalledWith('avoid_votes')
    expect(mockSupabase.eq).toHaveBeenCalledWith('trader_id', 'trader123')
    expect(mockSupabase.eq).toHaveBeenCalledWith('source', 'binance')
  })
})

describe('hasUserVoted', () => {
  test('should return false when user has not voted', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await hasUserVoted(mockSupabase as any, 'user1', 'trader1', 'binance')
    expect(result).toBe(false)
  })

  test('should return true when user has voted', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'vote1' }, error: null })

    const result = await hasUserVoted(mockSupabase as any, 'user1', 'trader1', 'binance')
    expect(result).toBe(true)
  })
})

describe('getUserAvoidVote', () => {
  test('should return null when no vote found', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const result = await getUserAvoidVote(mockSupabase as any, 'user1', 'trader1', 'binance')
    expect(result).toBeNull()
  })

  test('should return vote when found', async () => {
    const mockSupabase = createMockSupabase()
    const mockVote = {
      id: 'vote1',
      user_id: 'user1',
      trader_id: 'trader1',
      source: 'binance',
      reason: 'Test reason',
    }

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: mockVote, error: null })

    const result = await getUserAvoidVote(mockSupabase as any, 'user1', 'trader1', 'binance')
    expect(result).not.toBeNull()
    expect(result?.reason).toBe('Test reason')
  })
})

describe('createAvoidVote', () => {
  test('should create a new avoid vote', async () => {
    const mockSupabase = createMockSupabase()
    const mockVote = {
      id: 'newvote1',
      user_id: 'user1',
      trader_id: 'trader1',
      source: 'binance',
      reason: 'High drawdown',
      reason_type: 'high_drawdown',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: mockVote, error: null })

    const result = await createAvoidVote(mockSupabase as any, 'user1', {
      trader_id: 'trader1',
      source: 'binance',
      reason: 'High drawdown',
      reason_type: 'high_drawdown',
    })

    expect(result.reason).toBe('High drawdown')
    expect(mockSupabase.insert).toHaveBeenCalled()
  })

  test('should throw error on creation failure', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Creation failed') })

    await expect(
      createAvoidVote(mockSupabase as any, 'user1', { trader_id: 'trader1', source: 'binance' })
    ).rejects.toThrow()
  })
})

describe('updateAvoidVote', () => {
  test('should update an existing vote', async () => {
    const mockSupabase = createMockSupabase()
    const mockVote = {
      id: 'vote1',
      reason: 'Updated reason',
    }

    mockSupabase.single.mockResolvedValueOnce({ data: mockVote, error: null })

    const result = await updateAvoidVote(mockSupabase as any, 'vote1', 'user1', {
      reason: 'Updated reason',
    })

    expect(result.reason).toBe('Updated reason')
  })

  test('should throw error on update failure', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.single.mockResolvedValueOnce({ data: null, error: new Error('Update failed') })

    await expect(
      updateAvoidVote(mockSupabase as any, 'vote1', 'user1', { reason: 'Test' })
    ).rejects.toThrow()
  })
})

describe('deleteAvoidVote', () => {
  test('should delete a vote', async () => {
    const mockSupabase = createMockSupabase()
    // .delete().eq('id', voteId).eq('user_id', userId) - two eq() calls
    mockSupabase.eq
      .mockReturnValueOnce(mockSupabase) // First .eq() returns chain
      .mockResolvedValueOnce({ error: null }) // Second .eq() returns result

    await expect(deleteAvoidVote(mockSupabase as any, 'vote1', 'user1')).resolves.toBeUndefined()
    expect(mockSupabase.delete).toHaveBeenCalled()
    expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'vote1')
    expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user1')
  })

  test('should throw error on deletion failure', async () => {
    const mockSupabase = createMockSupabase()
    mockSupabase.eq
      .mockReturnValueOnce(mockSupabase) // First .eq() returns chain
      .mockResolvedValueOnce({ error: new Error('Delete failed') }) // Second .eq() returns error

    await expect(deleteAvoidVote(mockSupabase as any, 'vote1', 'user1')).rejects.toThrow()
  })
})
