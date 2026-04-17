'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { getCsrfHeaders } from '@/lib/api/client'

type UserResult = {
  id: string
  handle: string | null
  avatar_url: string | null
}

type CreateGroupModalProps = {
  isOpen: boolean
  onClose: () => void
}

export default function CreateGroupModal({ isOpen, onClose }: CreateGroupModalProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { accessToken } = useAuthSession()
  const modalRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!isOpen) return
    triggerRef.current = document.activeElement
    document.body.style.overflow = 'hidden'

    requestAnimationFrame(() => {
      if (modalRef.current) {
        const first = modalRef.current.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        first?.focus()
      }
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', handleKeyDown)
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus()
    }
  }, [isOpen, onClose])
  const [step, setStep] = useState<'members' | 'details'>('members')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserResult[]>([])
  const [selectedMembers, setSelectedMembers] = useState<UserResult[]>([])
  const [groupName, setGroupName] = useState('')
  const [description, setDescription] = useState('')
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const debouncedSearch = useCallback((query: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!query.trim()) { setSearchResults([]); return }
    searchTimerRef.current = setTimeout(() => searchUsers(query), 300)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- searchUsers defined after, circular dep

  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim() || !accessToken) return
    setSearching(true)
    try {
      const res = await globalThis.fetch(`/api/users/search?q=${encodeURIComponent(query)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      const data = await res.json()
      setSearchResults(data.users || [])
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [accessToken])

  const toggleMember = (user: UserResult) => {
    setSelectedMembers(prev => {
      if (prev.some(m => m.id === user.id)) {
        return prev.filter(m => m.id !== user.id)
      }
      if (prev.length >= 49) {
        showToast(t('maxGroupMembers'), 'warning')
        return prev
      }
      return [...prev, user]
    })
  }

  const handleCreate = async () => {
    if (!groupName.trim()) {
      showToast(t('groupNamePlaceholder'), 'warning')
      return
    }
    if (selectedMembers.length < 1) {
      showToast(t('minGroupMembers'), 'warning')
      return
    }

    setCreating(true)
    try {
      const res = await globalThis.fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
        body: JSON.stringify({
          name: groupName.trim(),
          description: description.trim() || undefined,
          memberIds: selectedMembers.map(m => m.id),
        }),
      })
      const data = await res.json()
      if (res.ok && data.channel) {
        showToast(t('groupCreated'), 'success')
        onClose()
        router.push(`/channels/${data.channel.id}`)
      } else {
        showToast(data.error || 'Failed', 'error')
      }
    } catch {
      showToast(t('createGroupFailed'), 'error')
    } finally {
      setCreating(false)
    }
  }

  if (!isOpen) return null

  return (
    <Box ref={modalRef} role="dialog" aria-modal="true" aria-label={t('createGroupChat')} style={{
      position: 'fixed', inset: 0, zIndex: tokens.zIndex.max,
      background: 'var(--color-backdrop)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <Box onClick={(e: React.MouseEvent) => e.stopPropagation()} style={{
        width: 420, maxWidth: '90vw', maxHeight: '80vh',
        background: tokens.colors.bg.secondary, borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        boxShadow: tokens.shadow.xl, display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <Box style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Text size="lg" weight="bold">{t('createGroupChat')}</Text>
          <button aria-label="Close" onClick={onClose} style={{
            width: 32, height: 32, borderRadius: '50%', border: 'none',
            background: 'transparent', color: tokens.colors.text.secondary, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </Box>

        <Box style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {step === 'members' ? (
            <>
              {/* Search */}
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); debouncedSearch(e.target.value) }}
                placeholder={t('searchUsers')}
                aria-label={t('searchUsers')}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary, color: tokens.colors.text.primary,
                  fontSize: 14, outline: 'none', marginBottom: 12,
                }}
              />

              {/* Selected chips */}
              {selectedMembers.length > 0 && (
                <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {selectedMembers.map(m => (
                    <Box key={m.id} style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 10px 4px 4px', borderRadius: tokens.radius['2xl'],
                      background: tokens.colors.bg.tertiary,
                    }}>
                      <Avatar userId={m.id} name={m.handle || m.id.slice(0, 8)} avatarUrl={m.avatar_url} size={20} />
                      <Text size="xs">{m.handle || m.id.slice(0, 8)}</Text>
                      <button onClick={() => toggleMember(m)} style={{
                        width: 16, height: 16, borderRadius: '50%', border: 'none',
                        background: 'transparent', color: tokens.colors.text.tertiary,
                        cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                      </button>
                    </Box>
                  ))}
                  <Text size="xs" color="tertiary" style={{ alignSelf: 'center' }}>
                    {t('selectedCount').replace('{n}', String(selectedMembers.length))}
                  </Text>
                </Box>
              )}

              {/* Results */}
              {searching && <Text size="sm" color="tertiary">{t('loading')}</Text>}
              {searchResults.map(u => {
                const isSelected = selectedMembers.some(m => m.id === u.id)
                return (
                  <button key={u.id} onClick={() => toggleMember(u)} style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 8px', borderRadius: tokens.radius.md, border: 'none',
                    background: isSelected ? `${tokens.colors.accent.brand}15` : 'transparent',
                    cursor: 'pointer', textAlign: 'left',
                    minHeight: 44,
                  }}>
                    <Avatar userId={u.id} name={u.handle || u.id.slice(0, 8)} avatarUrl={u.avatar_url} size={36} />
                    <Text size="sm" style={{ flex: 1, color: tokens.colors.text.primary }}>
                      {u.handle || u.id.slice(0, 8)}
                    </Text>
                    <Box style={{
                      width: 20, height: 20, borderRadius: tokens.radius.sm,
                      border: `2px solid ${isSelected ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
                      background: isSelected ? tokens.colors.accent.brand : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isSelected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5"/>
                        </svg>
                      )}
                    </Box>
                  </button>
                )
              })}
            </>
          ) : (
            <>
              <Box style={{ marginBottom: 16 }}>
                <Text size="sm" weight="bold" style={{ marginBottom: 6 }}>{t('groupName')} <span style={{ color: 'var(--color-accent-error)' }}>*</span></Text>
                <input
                  type="text"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  placeholder={t('groupNamePlaceholder')}
                  maxLength={50}
                  aria-label={t('groupName')}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary, color: tokens.colors.text.primary,
                    fontSize: 14, outline: 'none',
                  }}
                />
              </Box>
              <Box style={{ marginBottom: 16 }}>
                <Text size="sm" weight="bold" style={{ marginBottom: 6 }}>{t('groupDescription')}</Text>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="..."
                  maxLength={200}
                  rows={3}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary, color: tokens.colors.text.primary,
                    fontSize: 14, outline: 'none', resize: 'none',
                  }}
                />
              </Box>
              <Text size="xs" color="tertiary">
                {t('memberCount').replace('{n}', String(selectedMembers.length + 1))}
              </Text>
            </>
          )}
        </Box>

        {/* Footer */}
        <Box style={{
          display: 'flex', gap: 8, padding: '12px 20px',
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}>
          {step === 'details' && (
            <button onClick={() => setStep('members')} style={{
              flex: 1, padding: '10px', borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent', color: tokens.colors.text.primary,
              fontWeight: 600, cursor: 'pointer', minHeight: 44,
            }}>
              {t('back') || '返回'}
            </button>
          )}
          <button
            onClick={step === 'members' ? () => setStep('details') : handleCreate}
            disabled={step === 'members' ? selectedMembers.length < 1 : !groupName.trim() || creating}
            style={{
              flex: 1, padding: '10px', borderRadius: tokens.radius.md, border: 'none',
              background: tokens.gradient.primary, color: 'var(--color-on-accent)',
              fontWeight: 700, cursor: 'pointer', minHeight: 44,
              opacity: (step === 'members' && selectedMembers.length < 1) || (step === 'details' && (!groupName.trim() || creating)) ? 0.5 : 1,
            }}
          >
            {step === 'members' ? (t('next') || '下一步') : creating ? <><ButtonSpinner size="xs" /> {t('loading')}</> : t('createGroup')}
          </button>
        </Box>
      </Box>
    </Box>
  )
}
