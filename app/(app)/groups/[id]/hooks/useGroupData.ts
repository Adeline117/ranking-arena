'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { t } from '@/lib/i18n'

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

export function useGroupData({ groupId, userId, accessToken, showToast, language: _language }: UseGroupDataOptions) {
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
        .select('id, name, name_en, description, description_en, avatar_url, member_count, created_at, created_by, rules, is_premium_only')
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
        const isInvalidId = groupErr.code === '22P02' || groupErr.message?.includes('invalid input syntax')
        setError(isInvalidId ? t('groupNotFound') : t('loadFailed'))
        setLoading(false)
        return
      }

      setGroup(groupData ? { ...groupData, owner_handle: ownerHandle } as Group : null)

      // Check membership
      if (userId) {
        const { data: membership } = await supabase
          .from('group_members')
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
  const handleJoin = useCallback(async (_bypassPro = false) => {
    if (!userId || !accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    setJoining(true)
    try {
      const { error: joinErr } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: userId, role: 'member' })

      if (joinErr) {
        if (joinErr.code === '23505') {
          setIsMember(true)
          showToast(t('groupAlreadyMember'), 'warning')
        } else {
          showToast(joinErr.message, 'error')
        }
      } else {
        setIsMember(true)
        setUserRole('member')
        setGroup(prev => prev ? { ...prev, member_count: (prev.member_count || 0) + 1 } : null)
        showToast(t('joinedGroup'), 'success')
      }
    } catch (err) {
      logger.error('Join error:', err)
      showToast(t('joinFailed'), 'error')
    } finally {
      setJoining(false)
    }
  }, [userId, accessToken, groupId, showToast])

  // Leave group
  const handleLeave = useCallback(async () => {
    if (!userId) return

    try {
      const { error: leaveErr } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', userId)

      if (leaveErr) {
        showToast(leaveErr.message, 'error')
      } else {
        setIsMember(false)
        setUserRole(null)
        setGroup(prev => prev ? { ...prev, member_count: Math.max(0, (prev.member_count || 1) - 1) } : null)
        showToast(t('leftGroup'), 'success')
      }
    } catch (err) {
      logger.error('Leave error:', err)
      showToast(t('leaveFailed'), 'error')
    }
  }, [userId, groupId, showToast])

  // Load members
  const loadMembers = useCallback(async () => {
    if (!groupId) return
    setLoadingMembers(true)
    try {
      const { data } = await supabase
        .from('group_members')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('joined_at', { ascending: true })
        .limit(50)

      if (data && data.length > 0) {
        const userIds = data.map(m => m.user_id)
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', userIds)

        const profileMap = new Map(profiles?.map(p => [p.id, p]) || [])
        const membersList: GroupMember[] = data.map(m => ({
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
