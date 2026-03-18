'use client'

import { useState, useCallback } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'

type GroupMember = {
  user_id: string
  role: 'owner' | 'admin' | 'member'
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
  muted_until?: string | null
  mute_reason?: string | null
}

interface MemberListProps {
  members: GroupMember[]
  groupId: string
  userId: string | null
  userRole: 'owner' | 'admin' | 'member' | null
  isOwner: boolean
  canManage: boolean
  createdBy?: string | null
  accessToken: string | null
  memberSearch: string
  setMemberSearch: (v: string) => void
  debouncedMemberSearch: string
  memberPage: number
  setMemberPage: (v: number | ((p: number) => number)) => void
  memberRoleFilter: 'all' | 'owner' | 'admin' | 'member'
  setMemberRoleFilter: (v: 'all' | 'owner' | 'admin' | 'member') => void
  inviteUrl: string | null
  setInviteUrl: (v: string | null) => void
  generatingInvite: boolean
  setGeneratingInvite: (v: boolean) => void
  onMute: (userId: string) => void
  onUnmute: (userId: string) => void
  onSetRole: (userId: string, role: 'admin' | 'member') => void
  onKick: (userId: string, handle: string) => void
  onNotifyOpen: () => void
  setMembers: React.Dispatch<React.SetStateAction<GroupMember[]>>
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  t: (key: string) => string
}

const MEMBERS_PER_PAGE = 20

export default function MemberList({
  members, groupId, userId, userRole, isOwner, canManage, createdBy, accessToken,
  memberSearch, setMemberSearch, debouncedMemberSearch,
  memberPage, setMemberPage, memberRoleFilter, setMemberRoleFilter,
  inviteUrl, setInviteUrl, generatingInvite, setGeneratingInvite,
  onMute, onUnmute, onSetRole, onKick, onNotifyOpen,
  showToast, t,
}: MemberListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchKicking, setBatchKicking] = useState(false)

  const filtered = members
    .filter(m => memberRoleFilter === 'all' || m.role === memberRoleFilter)
    .filter(m => !debouncedMemberSearch || (m.handle || '').toLowerCase().includes(debouncedMemberSearch.toLowerCase()))
  const totalFiltered = filtered.length
  const totalMemberPages = Math.ceil(totalFiltered / MEMBERS_PER_PAGE)
  const paginatedMembers = filtered.slice(memberPage * MEMBERS_PER_PAGE, (memberPage + 1) * MEMBERS_PER_PAGE)

  const toggleSelect = useCallback((uid: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    const kickable = paginatedMembers.filter(m => {
      const memberIsOwner = m.role === 'owner' || (m.role === 'admin' && createdBy === m.user_id)
      return (isOwner || (userRole === 'admin' && m.role === 'member')) && m.user_id !== userId && !memberIsOwner
    })
    const allSelected = kickable.every(m => selectedIds.has(m.user_id))
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        kickable.forEach(m => next.delete(m.user_id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        kickable.forEach(m => next.add(m.user_id))
        return next
      })
    }
  }, [paginatedMembers, selectedIds, isOwner, userRole, userId, createdBy])

  const handleBatchKick = useCallback(async () => {
    if (selectedIds.size === 0 || batchKicking) return
    setBatchKicking(true)
    const ids = Array.from(selectedIds)
    for (const uid of ids) {
      const member = members.find(m => m.user_id === uid)
      if (member) {
        onKick(uid, member.handle || 'Unknown')
      }
    }
    setSelectedIds(new Set())
    setBatchKicking(false)
  }, [selectedIds, batchKicking, members, onKick])

  return (
    <Card title={`${t('memberList')} (${members.length})`}>
      {/* Search + filter + actions */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
          <input type="text" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder={t('searchMembers')}
            style={{ flex: 1, minWidth: 120, padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.primary, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm }}
          />
          <select value={memberRoleFilter} onChange={(e) => setMemberRoleFilter(e.target.value as typeof memberRoleFilter)}
            style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}`, background: tokens.colors.bg.primary, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm, cursor: 'pointer' }}
          >
            <option value="all">{t('allRoles')}</option>
            <option value="owner">{t('owner')}</option>
            <option value="admin">{t('admin')}</option>
            <option value="member">{t('groupMember')}</option>
          </select>
          <Button variant="primary" size="sm" onClick={onNotifyOpen}>{t('notifyMembers')}</Button>
          <Button variant="secondary" size="sm" disabled={generatingInvite} onClick={async () => {
            setGeneratingInvite(true)
            try {
              const res = await fetch(`/api/groups/${groupId}/invite`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() } })
              if (res.ok) {
                const data = await res.json()
                if (data.invite_url) { const fullUrl = `${window.location.origin}${data.invite_url}`; setInviteUrl(fullUrl); try { await navigator.clipboard.writeText(fullUrl); showToast(t('inviteLinkCopied'), 'success') } catch { showToast(t('copyFailed') || 'Copy failed', 'error') } }
                else showToast(t('generateFailed'), 'error')
              } else { const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null; showToast(data?.error || t('generateFailed'), 'error') }
            } catch { showToast(t('networkError'), 'error') }
            finally { setGeneratingInvite(false) }
          }}>
            {generatingInvite ? '...' : t('inviteLink')}
          </Button>
        </Box>
        {inviteUrl && (
          <Box style={{ padding: tokens.spacing[2], background: tokens.colors.bg.primary, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}` }}>
            <Text size="xs" color="tertiary" style={{ wordBreak: 'break-all' }}>{inviteUrl}</Text>
          </Box>
        )}
      </Box>

      {/* Batch actions bar */}
      {canManage && selectedIds.size > 0 && (
        <Box style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          background: 'var(--color-accent-error-10, rgba(239,68,68,0.1))',
          borderRadius: tokens.radius.md, marginBottom: tokens.spacing[2],
        }}>
          <Text size="sm" weight="semibold">
            {selectedIds.size} {t('selected') || 'selected'}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <Button variant="secondary" size="sm" onClick={() => setSelectedIds(new Set())}>
              {t('cancel') || 'Cancel'}
            </Button>
            <Button variant="secondary" size="sm" disabled={batchKicking}
              onClick={handleBatchKick}
              style={{ color: 'var(--color-accent-error)' }}
            >
              {batchKicking ? '...' : (t('batchKick') || `Kick ${selectedIds.size}`)}
            </Button>
          </Box>
        </Box>
      )}

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {/* Select all toggle */}
        {canManage && paginatedMembers.length > 0 && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], padding: `0 ${tokens.spacing[3]}` }}>
            <input
              type="checkbox"
              checked={paginatedMembers.filter(m => {
                const mIsOwner = m.role === 'owner' || (m.role === 'admin' && createdBy === m.user_id)
                return (isOwner || (userRole === 'admin' && m.role === 'member')) && m.user_id !== userId && !mIsOwner
              }).every(m => selectedIds.has(m.user_id)) && paginatedMembers.some(m => {
                const mIsOwner = m.role === 'owner' || (m.role === 'admin' && createdBy === m.user_id)
                return (isOwner || (userRole === 'admin' && m.role === 'member')) && m.user_id !== userId && !mIsOwner
              })}
              onChange={toggleSelectAll}
              style={{ cursor: 'pointer', width: 16, height: 16 }}
            />
            <Text size="xs" color="tertiary">{t('selectAll') || 'Select All'}</Text>
          </Box>
        )}
        {members.length === 0 && <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>{t('noMembersData')}</Text>}
        {paginatedMembers.length === 0 && members.length > 0 && <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>{t('noMatchingMembers')}</Text>}
        
        {paginatedMembers.map((member) => {
          const isMuted = member.muted_until && new Date(member.muted_until) > new Date()
          const memberIsOwner = member.role === 'owner' || (member.role === 'admin' && createdBy === member.user_id)
          const canManageMember = (isOwner || (userRole === 'admin' && member.role === 'member')) && member.user_id !== userId && !memberIsOwner

          return (
            <Box key={member.user_id} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], padding: tokens.spacing[3], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
              {canManageMember && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(member.user_id)}
                  onChange={() => toggleSelect(member.user_id)}
                  style={{ cursor: 'pointer', width: 16, height: 16, flexShrink: 0 }}
                />
              )}
              <Box style={{ width: 40, height: 40, borderRadius: '50%', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
                {member.avatar_url ? <Image src={member.avatar_url} alt={member.handle || 'Member avatar'} fill sizes="36px" style={{ objectFit: 'cover' }} /> : <Text size="sm" color="tertiary">{(member.handle || 'U').charAt(0).toUpperCase()}</Text>}
              </Box>
              <Box style={{ flex: 1 }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text weight="bold">@{member.handle || 'Unknown'}</Text>
                  <span style={{ fontSize: tokens.typography.fontSize.xs, padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full, background: memberIsOwner ? 'linear-gradient(135deg, #FFD700, #FFA500)' : member.role === 'admin' ? 'var(--color-accent-primary-30)' : tokens.colors.bg.primary, color: memberIsOwner ? 'var(--color-text-primary)' : tokens.colors.text.secondary }}>
                    {memberIsOwner ? t('owner') : member.role === 'admin' ? t('admin') : t('groupMember')}
                  </span>
                  {isMuted && <span style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-accent-error)', background: 'var(--color-accent-error-10)', padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full }}>{t('memberMutedBadge')}</span>}
                </Box>
                {isMuted && member.mute_reason && <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>{t('muteReasonLabel')}: {member.mute_reason}</Text>}
              </Box>
              {canManageMember && (
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  {isMuted ? <Button variant="secondary" size="sm" onClick={() => onUnmute(member.user_id)}>{t('unmute')}</Button>
                    : <Button variant="secondary" size="sm" onClick={() => onMute(member.user_id)}>{t('mute')}</Button>}
                  {isOwner && !memberIsOwner && <Button variant="secondary" size="sm" onClick={() => onSetRole(member.user_id, member.role === 'admin' ? 'member' : 'admin')}>{member.role === 'admin' && !memberIsOwner ? t('removeAdmin') : t('makeAdmin')}</Button>}
                  <Button variant="secondary" size="sm" onClick={() => onKick(member.user_id, member.handle || 'Unknown')} style={{ color: 'var(--color-accent-error)' }}>{t('kick')}</Button>
                </Box>
              )}
            </Box>
          )
        })}

        {totalMemberPages > 1 && (
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[3], marginTop: tokens.spacing[4], paddingTop: tokens.spacing[3], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
            <Button variant="secondary" size="sm" disabled={memberPage === 0} onClick={() => setMemberPage((p: number) => Math.max(0, p - 1))}>{t('prevPage')}</Button>
            <Text size="sm" color="secondary">{t('pageOf').replace('{current}', String(memberPage + 1)).replace('{total}', String(totalMemberPages))}</Text>
            <Button variant="secondary" size="sm" disabled={memberPage >= totalMemberPages - 1} onClick={() => setMemberPage((p: number) => Math.min(totalMemberPages - 1, p + 1))}>{t('nextPage')}</Button>
          </Box>
        )}
      </Box>
    </Card>
  )
}
