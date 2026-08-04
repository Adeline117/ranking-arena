'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  readGroupChannelCreationAcknowledgement,
  readGroupMemberSearchResults,
} from '@/lib/chat/group-channel-client-contract'

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
  const { accessToken, userId } = useAuthSession()
  const [step, setStep] = useState<'members' | 'details'>('members')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserResult[]>([])
  const [selectedMembers, setSelectedMembers] = useState<UserResult[]>([])
  const [groupName, setGroupName] = useState('')
  const [description, setDescription] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [creating, setCreating] = useState(false)
  const submittingRef = useRef<number | null>(null)
  const submissionSequenceRef = useRef(0)
  const creationIntentIdRef = useRef<string | null>(null)
  const creationIntentActorIdRef = useRef<string | null>(null)
  const creationGenerationRef = useRef(0)
  const createAbortRef = useRef<AbortController | null>(null)
  const searchGenerationRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const searchQueryRef = useRef('')
  const viewerRef = useRef({ isOpen, userId: userId?.toLowerCase() ?? null })
  viewerRef.current = { isOpen, userId: userId?.toLowerCase() ?? null }

  const handleClose = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = null
    searchGenerationRef.current += 1
    creationGenerationRef.current += 1
    searchAbortRef.current?.abort()
    createAbortRef.current?.abort()
    submittingRef.current = null
    setSearching(false)
    setCreating(false)
    onClose()
  }, [onClose])

  const searchUsers = useCallback(
    async (query: string) => {
      const normalizedQuery = query.trim()
      const actorId = userId?.toLowerCase() ?? null
      if (!normalizedQuery || normalizedQuery.length > 80 || !accessToken || !actorId || !isOpen) {
        return
      }

      searchAbortRef.current?.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller
      const generation = ++searchGenerationRef.current
      setSearching(true)
      setSearchError(false)
      try {
        const res = await globalThis.fetch(
          `/api/users/search?q=${encodeURIComponent(normalizedQuery)}&limit=10`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          }
        )
        const data: unknown = await res.json().catch(() => null)
        const users = res.ok ? readGroupMemberSearchResults(data, actorId, 10) : null
        const currentViewer = viewerRef.current
        if (
          controller.signal.aborted ||
          generation !== searchGenerationRef.current ||
          !currentViewer.isOpen ||
          currentViewer.userId !== actorId ||
          searchQueryRef.current.trim() !== normalizedQuery
        ) {
          return
        }
        if (!users) throw new Error('Invalid member search response')
        setSearchResults(users)
      } catch {
        if (!controller.signal.aborted && generation === searchGenerationRef.current) {
          setSearchError(true)
        }
      } finally {
        if (!controller.signal.aborted && generation === searchGenerationRef.current) {
          setSearching(false)
        }
      }
    },
    [accessToken, isOpen, userId]
  )

  const debouncedSearch = useCallback(
    (query: string) => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
      searchAbortRef.current?.abort()
      searchGenerationRef.current += 1
      if (!query.trim()) {
        setSearching(false)
        setSearchError(false)
        setSearchResults([])
        return
      }
      searchTimerRef.current = setTimeout(() => void searchUsers(query), 300)
    },
    [searchUsers]
  )

  useEffect(() => {
    searchGenerationRef.current += 1
    creationGenerationRef.current += 1
    searchAbortRef.current?.abort()
    createAbortRef.current?.abort()
    submittingRef.current = null
    setSearching(false)
    setCreating(false)
    setSearchError(false)
    setSearchResults([])
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = null

    return () => {
      searchGenerationRef.current += 1
      creationGenerationRef.current += 1
      searchAbortRef.current?.abort()
      createAbortRef.current?.abort()
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [isOpen, userId])

  const toggleMember = (user: UserResult) => {
    setSelectedMembers((prev) => {
      if (prev.some((m) => m.id === user.id)) {
        creationIntentIdRef.current = null
        creationGenerationRef.current += 1
        return prev.filter((m) => m.id !== user.id)
      }
      if (prev.length >= 49) {
        showToast(t('maxGroupMembers'), 'warning')
        return prev
      }
      creationIntentIdRef.current = null
      creationGenerationRef.current += 1
      return [...prev, user]
    })
  }

  const handleCreate = async () => {
    // Ref-based guard: synchronous, prevents duplicate submissions even when
    // React batches the setState(creating) update across rapid clicks.
    if (submittingRef.current !== null) return
    const submissionId = ++submissionSequenceRef.current
    submittingRef.current = submissionId

    if (!groupName.trim()) {
      showToast(t('groupNamePlaceholder'), 'warning')
      submittingRef.current = null
      return
    }
    if (selectedMembers.length < 1) {
      showToast(t('minGroupMembers'), 'warning')
      submittingRef.current = null
      return
    }
    if (!accessToken || !userId) {
      showToast(t('createGroupFailed'), 'error')
      submittingRef.current = null
      return
    }

    setCreating(true)
    try {
      const actorScope = userId.toLowerCase()
      if (creationIntentActorIdRef.current !== actorScope) {
        creationIntentIdRef.current = null
        creationIntentActorIdRef.current = actorScope
      }
      const channelId = creationIntentIdRef.current ?? globalThis.crypto.randomUUID()
      creationIntentIdRef.current = channelId
      const generation = creationGenerationRef.current
      const expectedName = groupName.trim()
      const expectedDescription = description.trim() || null
      const controller = new AbortController()
      createAbortRef.current?.abort()
      createAbortRef.current = controller
      const res = await globalThis.fetch('/api/channels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          channelId,
          name: expectedName,
          description: expectedDescription ?? undefined,
          memberIds: selectedMembers.map((m) => m.id),
        }),
        signal: controller.signal,
      })
      const data: unknown = await res.json().catch(() => null)
      const acknowledgement = res.ok
        ? readGroupChannelCreationAcknowledgement(data, {
            actorId: actorScope,
            channelId,
            description: expectedDescription,
            name: expectedName,
          })
        : null
      const currentViewer = viewerRef.current
      if (
        controller.signal.aborted ||
        generation !== creationGenerationRef.current ||
        !currentViewer.isOpen ||
        currentViewer.userId !== actorScope ||
        submittingRef.current !== submissionId
      ) {
        return
      }
      if (acknowledgement) {
        creationIntentIdRef.current = null
        showToast(t('groupCreated'), 'success')
        handleClose()
        router.push(`/channels/${acknowledgement.channelId}`)
      } else {
        showToast(t('createGroupFailed'), 'error')
      }
    } catch {
      if (submittingRef.current === submissionId && viewerRef.current.isOpen) {
        showToast(t('createGroupFailed'), 'error')
      }
    } finally {
      if (submittingRef.current === submissionId) {
        setCreating(false)
        submittingRef.current = null
      }
    }
  }

  return (
    <ModalOverlay open={isOpen} onClose={handleClose} label={t('createGroupChat')}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '80vh',
        }}
      >
        {/* Header */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold">
            {t('createGroupChat')}
          </Text>
          <button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
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
                onChange={(e) => {
                  searchQueryRef.current = e.target.value
                  setSearchQuery(e.target.value)
                  setSearchResults([])
                  setSearchError(false)
                  debouncedSearch(e.target.value)
                }}
                placeholder={t('searchUsers')}
                aria-label={t('searchUsers')}
                maxLength={80}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  outline: 'none',
                  marginBottom: 12,
                  minHeight: 44,
                }}
              />

              {/* Selected chips */}
              {selectedMembers.length > 0 && (
                <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {selectedMembers.map((m) => (
                    <Box
                      key={m.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 10px 4px 4px',
                        borderRadius: tokens.radius['2xl'],
                        background: tokens.colors.bg.tertiary,
                      }}
                    >
                      <Avatar
                        userId={m.id}
                        name={m.handle || m.id.slice(0, 8)}
                        avatarUrl={m.avatar_url}
                        size={20}
                      />
                      <Text size="xs">{m.handle || m.id.slice(0, 8)}</Text>
                      <button
                        type="button"
                        aria-label={`${t('remove')} ${m.handle || m.id.slice(0, 8)}`}
                        onClick={() => toggleMember(m)}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          border: 'none',
                          background: 'transparent',
                          color: tokens.colors.text.tertiary,
                          cursor: 'pointer',
                          padding: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
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
              {searching && (
                <Text size="sm" color="tertiary" role="status">
                  {t('loading')}
                </Text>
              )}
              {searchError && !searching && (
                <Box
                  role="alert"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}
                >
                  <Text size="sm" color="tertiary" style={{ flex: 1 }}>
                    {t('searchFailed')}
                  </Text>
                  <button
                    type="button"
                    onClick={() => void searchUsers(searchQueryRef.current)}
                    style={{
                      minWidth: 72,
                      minHeight: 44,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.tertiary,
                      color: tokens.colors.text.primary,
                      cursor: 'pointer',
                    }}
                  >
                    {t('retry')}
                  </button>
                </Box>
              )}
              {searchResults.map((u) => {
                const isSelected = selectedMembers.some((m) => m.id === u.id)
                return (
                  <button
                    type="button"
                    key={u.id}
                    onClick={() => toggleMember(u)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 8px',
                      borderRadius: tokens.radius.md,
                      border: 'none',
                      background: isSelected
                        ? `${alpha(tokens.colors.accent.brand, 8)}`
                        : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      minHeight: 44,
                    }}
                  >
                    <Avatar
                      userId={u.id}
                      name={u.handle || u.id.slice(0, 8)}
                      avatarUrl={u.avatar_url}
                      size={36}
                    />
                    <Text size="sm" style={{ flex: 1, color: tokens.colors.text.primary }}>
                      {u.handle || u.id.slice(0, 8)}
                    </Text>
                    <Box
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: tokens.radius.sm,
                        border: `2px solid ${isSelected ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
                        background: isSelected ? tokens.colors.accent.brand : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSelected && (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="white"
                          strokeWidth="3"
                        >
                          <path d="M20 6L9 17l-5-5" />
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
                <Text size="sm" weight="bold" style={{ marginBottom: 6 }}>
                  {t('groupName')} <span style={{ color: 'var(--color-accent-error)' }}>*</span>
                </Text>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => {
                    creationIntentIdRef.current = null
                    creationGenerationRef.current += 1
                    setGroupName(e.target.value)
                  }}
                  placeholder={t('groupNamePlaceholder')}
                  maxLength={50}
                  aria-label={t('groupName')}
                  disabled={creating}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.base,
                    outline: 'none',
                  }}
                />
                <Text size="xs" color="tertiary" style={{ marginTop: 4, textAlign: 'right' }}>
                  {groupName.length}/50
                </Text>
              </Box>
              <Box style={{ marginBottom: 16 }}>
                <Text size="sm" weight="bold" style={{ marginBottom: 6 }}>
                  {t('groupDescription')}
                </Text>
                <textarea
                  value={description}
                  onChange={(e) => {
                    creationIntentIdRef.current = null
                    creationGenerationRef.current += 1
                    setDescription(e.target.value)
                  }}
                  placeholder="..."
                  maxLength={200}
                  rows={3}
                  aria-label={t('groupDescription')}
                  disabled={creating}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.base,
                    outline: 'none',
                    resize: 'none',
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
        <Box
          style={{
            display: 'flex',
            gap: 8,
            padding: '12px 20px',
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {step === 'details' && (
            <button
              type="button"
              onClick={() => setStep('members')}
              disabled={creating}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.primary,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              {t('back')}
            </button>
          )}
          <button
            type="button"
            onClick={step === 'members' ? () => setStep('details') : handleCreate}
            disabled={
              step === 'members' ? selectedMembers.length < 1 : !groupName.trim() || creating
            }
            style={{
              flex: 1,
              padding: '10px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: tokens.gradient.primary,
              color: 'var(--color-on-accent)',
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
              minHeight: 44,
              opacity:
                (step === 'members' && selectedMembers.length < 1) ||
                (step === 'details' && (!groupName.trim() || creating))
                  ? 0.5
                  : 1,
            }}
          >
            {step === 'members' ? (
              t('next')
            ) : creating ? (
              <>
                <ButtonSpinner size="xs" /> {t('loading')}
              </>
            ) : (
              t('createGroup')
            )}
          </button>
        </Box>
      </div>
    </ModalOverlay>
  )
}
