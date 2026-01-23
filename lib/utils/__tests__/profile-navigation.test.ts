/**
 * Profile navigation utility tests
 * Ensures correct navigation behavior for chat avatars
 */

import {
  getProfileUrl,
  isValidNavigationTarget,
  getSafeProfileUrl,
  type ProfileTarget,
} from '../profile-navigation'

describe('profile-navigation', () => {
  describe('getProfileUrl', () => {
    it('should return /u/{handle} when handle is available', () => {
      const target: ProfileTarget = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: 'trader_bob',
      }
      expect(getProfileUrl(target)).toBe('/u/trader_bob')
    })

    it('should return /u/{id} when handle is null', () => {
      const target: ProfileTarget = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: null,
      }
      expect(getProfileUrl(target)).toBe(
        '/u/550e8400-e29b-41d4-a716-446655440000'
      )
    })

    it('should return /u/{id} when handle is undefined', () => {
      const target: ProfileTarget = {
        id: '550e8400-e29b-41d4-a716-446655440000',
      }
      expect(getProfileUrl(target)).toBe(
        '/u/550e8400-e29b-41d4-a716-446655440000'
      )
    })

    it('should encode special characters in handle', () => {
      const target: ProfileTarget = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: '用户名',
      }
      expect(getProfileUrl(target)).toBe('/u/%E7%94%A8%E6%88%B7%E5%90%8D')
    })

    it('should return null for null target', () => {
      expect(getProfileUrl(null)).toBeNull()
    })

    it('should return null for undefined target', () => {
      expect(getProfileUrl(undefined)).toBeNull()
    })

    it('should return null for target with empty id', () => {
      const target: ProfileTarget = { id: '', handle: 'test' }
      expect(getProfileUrl(target)).toBeNull()
    })

    it('should use full UUID when handle is missing (not truncated)', () => {
      const fullId = '550e8400-e29b-41d4-a716-446655440000'
      const target: ProfileTarget = { id: fullId, handle: null }
      const url = getProfileUrl(target)
      // Should contain the FULL UUID, not truncated
      expect(url).toContain(fullId)
      expect(url).toBe(`/u/${fullId}`)
    })
  })

  describe('isValidNavigationTarget', () => {
    const currentUserId = 'user-111-222-333'

    it('should return true when target is different user', () => {
      const target: ProfileTarget = {
        id: 'user-444-555-666',
        handle: 'other_user',
      }
      expect(isValidNavigationTarget(target, currentUserId)).toBe(true)
    })

    it('should return false when target is the current user', () => {
      const target: ProfileTarget = {
        id: currentUserId,
        handle: 'my_handle',
      }
      expect(isValidNavigationTarget(target, currentUserId)).toBe(false)
    })

    it('should return false for null target', () => {
      expect(isValidNavigationTarget(null, currentUserId)).toBe(false)
    })

    it('should return false for undefined target', () => {
      expect(isValidNavigationTarget(undefined, currentUserId)).toBe(false)
    })

    it('should return false for target with no id', () => {
      const target: ProfileTarget = { id: '', handle: 'test' }
      expect(isValidNavigationTarget(target, currentUserId)).toBe(false)
    })

    it('should return false when currentUserId is null', () => {
      const target: ProfileTarget = { id: 'some-id', handle: 'test' }
      expect(isValidNavigationTarget(target, null)).toBe(false)
    })

    it('should return false when currentUserId is undefined', () => {
      const target: ProfileTarget = { id: 'some-id', handle: 'test' }
      expect(isValidNavigationTarget(target, undefined)).toBe(false)
    })
  })

  describe('getSafeProfileUrl', () => {
    const currentUserId = 'user-111-222-333'

    it('should return profile URL for valid different user', () => {
      const target: ProfileTarget = {
        id: 'user-444-555-666',
        handle: 'trader_bob',
      }
      expect(getSafeProfileUrl(target, currentUserId)).toBe('/u/trader_bob')
    })

    it('should return null and call onError for self-navigation', () => {
      const target: ProfileTarget = {
        id: currentUserId,
        handle: 'my_handle',
      }
      const onError = jest.fn()
      const result = getSafeProfileUrl(target, currentUserId, onError)
      expect(result).toBeNull()
      expect(onError).toHaveBeenCalledWith('self_navigation')
    })

    it('should return null and call onError for null target', () => {
      const onError = jest.fn()
      const result = getSafeProfileUrl(null, currentUserId, onError)
      expect(result).toBeNull()
      expect(onError).toHaveBeenCalledWith('missing_data')
    })

    it('should return null and call onError for target with empty id', () => {
      const onError = jest.fn()
      const target: ProfileTarget = { id: '', handle: 'test' }
      const result = getSafeProfileUrl(target, currentUserId, onError)
      expect(result).toBeNull()
      expect(onError).toHaveBeenCalledWith('missing_data')
    })

    it('should work without onError callback', () => {
      const result = getSafeProfileUrl(null, currentUserId)
      expect(result).toBeNull()
    })

    it('should use UUID fallback when handle is null', () => {
      const target: ProfileTarget = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: null,
      }
      expect(getSafeProfileUrl(target, currentUserId)).toBe(
        '/u/550e8400-e29b-41d4-a716-446655440000'
      )
    })
  })

  describe('otherParticipant resolution (integration logic)', () => {
    // These tests verify the logic pattern used by the API to determine
    // the "other" participant in a conversation

    it('should correctly identify other user when current user is user1', () => {
      const userId = 'aaa-111'
      const conversation = { user1_id: 'aaa-111', user2_id: 'bbb-222' }
      const otherUserId =
        conversation.user1_id === userId
          ? conversation.user2_id
          : conversation.user1_id
      expect(otherUserId).toBe('bbb-222')
    })

    it('should correctly identify other user when current user is user2', () => {
      const userId = 'bbb-222'
      const conversation = { user1_id: 'aaa-111', user2_id: 'bbb-222' }
      const otherUserId =
        conversation.user1_id === userId
          ? conversation.user2_id
          : conversation.user1_id
      expect(otherUserId).toBe('aaa-111')
    })

    it('should never return current userId as the other user', () => {
      const testCases = [
        { userId: 'aaa', user1_id: 'aaa', user2_id: 'bbb' },
        { userId: 'bbb', user1_id: 'aaa', user2_id: 'bbb' },
        { userId: 'ccc', user1_id: 'ccc', user2_id: 'ddd' },
      ]

      for (const { userId, user1_id, user2_id } of testCases) {
        const otherUserId =
          user1_id === userId ? user2_id : user1_id
        expect(otherUserId).not.toBe(userId)
      }
    })

    it('should build correct profile URL from API response with handle', () => {
      // Simulates the full flow: API returns otherUser → getProfileUrl
      const apiResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: 'trader_bob',
        avatar_url: null,
        bio: null,
      }
      const url = getProfileUrl(apiResponse)
      expect(url).toBe('/u/trader_bob')
    })

    it('should build correct profile URL from API response without handle', () => {
      // When user has no handle set, API returns handle: null
      const apiResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: null,
        avatar_url: null,
        bio: null,
      }
      const url = getProfileUrl(apiResponse)
      // Should use full UUID so profile page can resolve it
      expect(url).toBe('/u/550e8400-e29b-41d4-a716-446655440000')
    })

    it('should NOT produce a truncated UUID in the URL', () => {
      // This was the original bug: handle was otherUserId.slice(0, 8)
      const apiResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        handle: null,
        avatar_url: null,
        bio: null,
      }
      const url = getProfileUrl(apiResponse)
      // The URL should NOT contain only the first 8 chars
      expect(url).not.toBe('/u/550e8400')
      // It should contain the full UUID
      expect(url).toContain('550e8400-e29b-41d4-a716-446655440000')
    })
  })
})
