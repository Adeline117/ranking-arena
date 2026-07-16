'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { t } from '@/lib/i18n'
import { getCsrfHeaders } from '@/lib/api/client'

export type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  created_at?: string | null
  created_by?: string | null
  rules?: string | null
  is_premium_only?: boolean | null
  owner_handle?: string | null
}

export type GroupMember = {
  user_id: string
  handle?: string | null
  avatar_url?: string | null
  role: 'owner' | 'admin' | 'member'
  joined_at?: string | null
}

interface UseGroupDataOptions {
  groupId: string
  userId: string | null
  accessToken: string | null
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  language: string
}

interface MembershipApiResult {
  action?: 'joined' | 'already_member' | 'left' | 'not_member' | 'requested'
  role?: 'owner' | 'admin' | 'member'
  member_count?: number
  error?: string
}

function isGroupRole(value: unknown): value is 'owner' | 'admin' | 'member' {
  return value === 'owner' || value === 'admin' || value === 'member'
}

function isCanonicalMemberCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function useGroupData({
  groupId,
  userId,
  accessToken,
  showToast,
  language: _language,
}: UseGroupDataOptions) {
  const [group, setGroup] = useState<Group | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [joining, setJoining] = useState(false)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Load group info and membership
  const loadGroup = useCallback(async () => {
    if (!groupId || groupId === 'loading') return

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    setLoading(true)
    setError(null)

    try {
      const { data: groupData, error: groupErr } = await supabase
        .from('groups')
        .select(
          'id, name, name_en, description, description_en, avatar_url, member_count, created_at, created_by, rules, is_premium_only'
        )
        .eq('id', groupId)
        .maybeSingle()

      if (controller.signal.aborted) return

      let ownerHandle = null
      if (groupData?.created_by) {
        const { data: ownerData } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', groupData.created_by)
          .maybeSingle()
        ownerHandle = ownerData?.handle
      }

      if (groupErr) {
        // Sanitize DB error messages — don't show raw SQL errors to users
        const isInvalidId =
          groupErr.code === '22P02' || groupErr.message?.includes('invalid input syntax')
        setError(isInvalidId ? t('groupNotFound') : t('loadFailed'))
        setLoading(false)
        return
      }

      setGroup(groupData ? ({ ...groupData, owner_handle: ownerHandle } as Group) : null)

      // Check membership
      if (userId) {
        const { data: membership } = await supabase
          .from('own_group_memberships')
          .select('role')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .maybeSingle()
        setIsMember(!!membership)
        setUserRole(membership?.role as 'owner' | 'admin' | 'member' | null)
      }
    } catch (err) {
      if (controller.signal.aborted) return
      const errorMsg = err instanceof Error ? err.message : t('loadFailed')
      setError(errorMsg)
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [groupId, userId])

  useEffect(() => {
    loadGroup()
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [loadGroup])

  // Join group
  const handleJoin = useCallback(
    async (_bypassPro = false) => {
      if (!userId || !accessToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }

      setJoining(true)
      try {
        const response = await fetch(`/api/groups/${groupId}/membership`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ action: 'join' }),
        })
        const result = (await response.json().catch(() => ({}))) as MembershipApiResult

        if (!response.ok) throw new Error(result.error || t('joinFailed'))
        if (result.action === 'requested') {
          showToast(t('joinRequestSubmitted'), 'success')
          return
        }
        if (result.action !== 'joined' && result.action !== 'already_member') {
          throw new Error(t('joinFailed'))
        }
        if (!isCanonicalMemberCount(result.member_count)) throw new Error(t('joinFailed'))
        if (result.action === 'already_member' && !isGroupRole(result.role)) {
          throw new Error(t('joinFailed'))
        }

        setIsMember(true)
        setUserRole(
          result.action === 'already_member' && isGroupRole(result.role) ? result.role : 'member'
        )
        setGroup((previousGroup) =>
          previousGroup
            ? { ...previousGroup, member_count: result.member_count as number }
            : previousGroup
        )
        showToast(
          t(result.action === 'already_member' ? 'groupAlreadyMember' : 'joinedGroup'),
          result.action === 'already_member' ? 'warning' : 'success'
        )
      } catch (err) {
        logger.error('Join error:', err)
        showToast(t('joinFailed'), 'error')
      } finally {
        setJoining(false)
      }
    },
    [userId, accessToken, groupId, showToast]
  )

  // Leave group
  const handleLeave = useCallback(async () => {
    if (!userId || !accessToken) return

    try {
      const response = await fetch(`/api/groups/${groupId}/membership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ action: 'leave' }),
      })
      const result = (await response.json().catch(() => ({}))) as MembershipApiResult

      if (!response.ok || (result.action !== 'left' && result.action !== 'not_member')) {
        throw new Error(result.error || t('leaveFailed'))
      }
      if (result.action === 'left') {
        if (!isCanonicalMemberCount(result.member_count)) throw new Error(t('leaveFailed'))
        setGroup((previousGroup) =>
          previousGroup
            ? { ...previousGroup, member_count: result.member_count as number }
            : previousGroup
        )
      }
      setIsMember(false)
      setUserRole(null)
      showToast(t('leftGroup'), 'success')
    } catch (err) {
      logger.error('Leave error:', err)
      showToast(t('leaveFailed'), 'error')
    }
  }, [userId, accessToken, groupId, showToast])

  // Load members
  const loadMembers = useCallback(async () => {
    if (!groupId) return
    setLoadingMembers(true)
    try {
      const { data } = await supabase
        .from('group_member_directory')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('joined_at', { ascending: true })
        .limit(50)

      if (data && data.length > 0) {
        const userIds = data.map((m) => m.user_id)
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', userIds)

        const profileMap = new Map(profiles?.map((p) => [p.id, p]) || [])
        const membersList: GroupMember[] = data.map((m) => ({
          user_id: m.user_id,
          handle: profileMap.get(m.user_id)?.handle,
          avatar_url: profileMap.get(m.user_id)?.avatar_url,
          role: m.role,
          joined_at: m.joined_at,
        }))
        setMembers(membersList)
      }
    } catch (err) {
      logger.error('Load members error:', err)
    } finally {
      setLoadingMembers(false)
    }
  }, [groupId])

  return {
    group,
    setGroup,
    loading,
    error,
    isMember,
    setIsMember,
    userRole,
    joining,
    members,
    loadingMembers,
    handleJoin,
    handleLeave,
    loadMembers,
    reload: loadGroup,
  }
}
