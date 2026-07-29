'use client'

/**
 * Verified Trader Profile Editor
 * Allows verified traders to edit their display_name, bio, avatar, and social links.
 * Only visible to the user who claimed the trader profile.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

export interface VerifiedTraderProfileData {
  profile_version: number
  display_name?: string | null
  bio?: string | null
  avatar_url?: string | null
  twitter_url?: string | null
  telegram_url?: string | null
  discord_url?: string | null
  website_url?: string | null
}

interface VerifiedTraderEditorProps {
  traderId: string
  source: string
  currentData: VerifiedTraderProfileData
  onSaved?: () => void
}

const EDITABLE_PROFILE_FIELDS = [
  'display_name',
  'bio',
  'twitter_url',
  'telegram_url',
  'discord_url',
  'website_url',
] as const

type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number]
type ProfileFormValues = Record<EditableProfileField, string>
type ProfileUpdates = Partial<Record<EditableProfileField, string | null>>

class VerifiedTraderProfileConflictError extends Error {}

function normalizedProfileValue(value: string): string | null {
  return value.trim() || null
}

function profileValuesFromData(data: VerifiedTraderProfileData): ProfileFormValues {
  return {
    display_name: data.display_name ?? '',
    bio: data.bio ?? '',
    twitter_url: data.twitter_url ?? '',
    telegram_url: data.telegram_url ?? '',
    discord_url: data.discord_url ?? '',
    website_url: data.website_url ?? '',
  }
}

function isValidProfileVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isProfileAcknowledgement(
  value: unknown,
  identity: { traderId: string; source: string },
  expectedVersion: number,
  updates: ProfileUpdates
): value is VerifiedTraderProfileData & { trader_id: string; source: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const acknowledgement = value as Record<string, unknown>
  return (
    acknowledgement.trader_id === identity.traderId &&
    acknowledgement.source === identity.source &&
    isValidProfileVersion(acknowledgement.profile_version) &&
    acknowledgement.profile_version >= expectedVersion &&
    acknowledgement.profile_version <= expectedVersion + 1 &&
    EDITABLE_PROFILE_FIELDS.every(
      (field) => acknowledgement[field] === null || typeof acknowledgement[field] === 'string'
    ) &&
    Object.entries(updates).every(([field, update]) => acknowledgement[field] === update)
  )
}

function responseErrorMessage(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const error = (value as Record<string, unknown>).error
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return ''
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' ? message : ''
}

function profileValuesEqual(left: ProfileFormValues, right: ProfileFormValues): boolean {
  return EDITABLE_PROFILE_FIELDS.every((field) => left[field] === right[field])
}

function changedProfileFields(
  initialValues: ProfileFormValues,
  currentValues: ProfileFormValues
): ProfileUpdates {
  const updates: ProfileUpdates = {}
  for (const field of EDITABLE_PROFILE_FIELDS) {
    const initialValue = normalizedProfileValue(initialValues[field])
    const currentValue = normalizedProfileValue(currentValues[field])
    if (currentValue !== initialValue) updates[field] = currentValue
  }
  return updates
}

export default function VerifiedTraderEditor({
  traderId,
  source,
  currentData,
  onSaved,
}: VerifiedTraderEditorProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()

  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const externalVersion = currentData.profile_version
  const externalValues = useMemo(() => profileValuesFromData(currentData), [currentData])
  const [formValues, setFormValues] = useState<ProfileFormValues>(() => externalValues)
  const initialValuesRef = useRef(externalValues)
  const lastExternalValuesRef = useRef(externalValues)
  const latestExternalValuesRef = useRef(externalValues)
  const initialVersionRef = useRef(externalVersion)
  const lastExternalVersionRef = useRef(externalVersion)
  const latestExternalVersionRef = useRef(externalVersion)
  const identityKey = `${source}\u0000${traderId}`
  const identityKeyRef = useRef(identityKey)
  const renderedIdentityKeyRef = useRef(identityKey)
  const saveGenerationRef = useRef(0)

  // These refs intentionally track the newest render synchronously. A pending
  // request may settle before effects for a new identity or refreshed profile
  // have run, so async completion must not rely on its render-time closure.
  latestExternalValuesRef.current = externalValues
  latestExternalVersionRef.current = externalVersion
  renderedIdentityKeyRef.current = identityKey

  useEffect(
    () => () => {
      // A completed request must not fire a toast/onSaved after navigation.
      saveGenerationRef.current += 1
    },
    []
  )

  // Profile data commonly arrives after the editor first renders. Adopt it only
  // while closed; a background revalidation must not overwrite an active draft.
  // Switching to another trader identity always discards the old identity's draft.
  useEffect(() => {
    const identityChanged = identityKeyRef.current !== identityKey
    if (identityChanged) {
      identityKeyRef.current = identityKey
      // Invalidate every await still in flight for the previous identity.
      // The old request may still finish, but it must become a complete no-op.
      saveGenerationRef.current += 1
      lastExternalValuesRef.current = externalValues
      lastExternalVersionRef.current = externalVersion
      initialValuesRef.current = externalValues
      initialVersionRef.current = externalVersion
      setFormValues(externalValues)
      setSaving(false)
      setIsEditing(false)
      return
    }
    if (
      isEditing ||
      (profileValuesEqual(lastExternalValuesRef.current, externalValues) &&
        lastExternalVersionRef.current === externalVersion)
    )
      return
    lastExternalValuesRef.current = externalValues
    lastExternalVersionRef.current = externalVersion
    initialValuesRef.current = externalValues
    initialVersionRef.current = externalVersion
    setFormValues(externalValues)
  }, [externalValues, externalVersion, identityKey, isEditing])

  const resetToLatestProfile = () => {
    const externalChanged =
      !profileValuesEqual(lastExternalValuesRef.current, externalValues) ||
      lastExternalVersionRef.current !== externalVersion
    const resetValues = externalChanged ? externalValues : initialValuesRef.current
    if (externalChanged) {
      lastExternalValuesRef.current = externalValues
      lastExternalVersionRef.current = externalVersion
      initialValuesRef.current = externalValues
      initialVersionRef.current = externalVersion
    }
    setFormValues(resetValues)
    setIsEditing(false)
  }

  const beginEditing = () => {
    const externalChanged =
      !profileValuesEqual(lastExternalValuesRef.current, externalValues) ||
      lastExternalVersionRef.current !== externalVersion
    const editValues = externalChanged ? externalValues : initialValuesRef.current
    if (externalChanged) {
      lastExternalValuesRef.current = externalValues
      lastExternalVersionRef.current = externalVersion
      initialValuesRef.current = externalValues
      initialVersionRef.current = externalVersion
    }
    setFormValues(editValues)
    setIsEditing(true)
  }

  const setProfileField = (field: EditableProfileField, value: string) => {
    setFormValues((previous) => ({ ...previous, [field]: value }))
  }

  const handleSave = async () => {
    const updates = changedProfileFields(initialValuesRef.current, formValues)
    if (Object.keys(updates).length === 0) {
      resetToLatestProfile()
      return
    }
    const expectedVersion = initialVersionRef.current
    if (!isValidProfileVersion(expectedVersion)) {
      showToast(t('verifiedTraderReloadRequired'), 'error')
      return
    }

    const saveIdentityKey = identityKey
    const saveGeneration = ++saveGenerationRef.current
    const isCurrentSave = () =>
      renderedIdentityKeyRef.current === saveIdentityKey &&
      identityKeyRef.current === saveIdentityKey &&
      saveGenerationRef.current === saveGeneration

    setSaving(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!isCurrentSave()) return
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      const res = await fetch('/api/traders/claim/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          trader_id: traderId,
          source,
          profile_version: expectedVersion,
          ...updates,
        }),
      })

      const responseData = await res.json().catch(() => null)
      if (!res.ok) {
        if (!isCurrentSave()) return
        if (res.status === 409) throw new VerifiedTraderProfileConflictError()
        throw new Error(responseErrorMessage(responseData) || 'Failed to save')
      }
      if (!isCurrentSave()) return
      const acknowledgement =
        typeof responseData === 'object' && responseData !== null && !Array.isArray(responseData)
          ? (responseData as Record<string, unknown>).data
          : null
      const verifiedTrader =
        typeof acknowledgement === 'object' &&
        acknowledgement !== null &&
        !Array.isArray(acknowledgement)
          ? (acknowledgement as Record<string, unknown>).verified_trader
          : null
      if (
        !isProfileAcknowledgement(verifiedTrader, { traderId, source }, expectedVersion, updates)
      ) {
        throw new Error('Invalid profile save acknowledgement')
      }

      showToast(t('verifiedTraderSaved'), 'success')
      const savedValues = profileValuesFromData(verifiedTrader)
      lastExternalValuesRef.current = latestExternalValuesRef.current
      lastExternalVersionRef.current = latestExternalVersionRef.current
      initialValuesRef.current = savedValues
      initialVersionRef.current = verifiedTrader.profile_version
      setFormValues(savedValues)
      setIsEditing(false)
      onSaved?.()
    } catch (error) {
      if (!isCurrentSave()) return
      if (error instanceof VerifiedTraderProfileConflictError) {
        showToast(t('verifiedTraderSaveConflict'), 'error')
        return
      }
      const msg = error instanceof Error ? error.message : ''
      showToast(`${t('verifiedTraderSaveFailed')} ${msg}`, 'error')
    } finally {
      // An older response must not clear the spinner for a newer save.
      if (isCurrentSave()) setSaving(false)
    }
  }

  if (!isEditing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={beginEditing}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.accent.primary,
        }}
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        {t('verifiedTraderEditProfile')}
      </Button>
    )
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: tokens.spacing[2],
    borderRadius: tokens.radius.md,
    border: `1px solid ${tokens.colors.border.primary}`,
    backgroundColor: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.sm,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: tokens.spacing[1],
    fontWeight: 500,
    fontSize: tokens.typography.fontSize.xs,
    color: tokens.colors.text.secondary,
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        backgroundColor: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        marginTop: tokens.spacing[3],
      }}
    >
      <Text
        style={{
          fontSize: tokens.typography.fontSize.md,
          fontWeight: 700,
          marginBottom: tokens.spacing[3],
        }}
      >
        {t('verifiedTraderEditProfile')}
      </Text>

      <Box style={{ display: 'grid', gap: tokens.spacing[3] }}>
        <Box>
          <label htmlFor="vt-display-name" style={labelStyle}>
            {t('verifiedTraderDisplayName')}
          </label>
          <input
            id="vt-display-name"
            type="text"
            value={formValues.display_name}
            onChange={(e) => setProfileField('display_name', e.target.value)}
            maxLength={50}
            style={inputStyle}
          />
        </Box>

        <Box>
          <label htmlFor="vt-bio" style={labelStyle}>
            {t('verifiedTraderBio')}
          </label>
          <textarea
            id="vt-bio"
            value={formValues.bio}
            onChange={(e) => setProfileField('bio', e.target.value)}
            maxLength={280}
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Box>

        <Box>
          <label htmlFor="vt-twitter" style={labelStyle}>
            {t('verifiedTraderTwitter')}
          </label>
          <input
            id="vt-twitter"
            type="url"
            value={formValues.twitter_url}
            onChange={(e) => setProfileField('twitter_url', e.target.value)}
            placeholder="https://x.com/username"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label htmlFor="vt-telegram" style={labelStyle}>
            {t('verifiedTraderTelegram')}
          </label>
          <input
            id="vt-telegram"
            type="url"
            value={formValues.telegram_url}
            onChange={(e) => setProfileField('telegram_url', e.target.value)}
            placeholder="https://t.me/username"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label htmlFor="vt-discord" style={labelStyle}>
            {t('verifiedTraderDiscord')}
          </label>
          <input
            id="vt-discord"
            type="text"
            value={formValues.discord_url}
            onChange={(e) => setProfileField('discord_url', e.target.value)}
            placeholder="username#1234"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label htmlFor="vt-website" style={labelStyle}>
            {t('verifiedTraderWebsite')}
          </label>
          <input
            id="vt-website"
            type="url"
            value={formValues.website_url}
            onChange={(e) => setProfileField('website_url', e.target.value)}
            placeholder="https://example.com"
            style={inputStyle}
          />
        </Box>
      </Box>

      <Box
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginTop: tokens.spacing[4],
          justifyContent: 'flex-end',
        }}
      >
        <Button variant="ghost" size="sm" onClick={resetToLatestProfile} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? `⏳ ${t('verifiedTraderSaving')}` : t('verifiedTraderSaveChanges')}
        </Button>
      </Box>
    </Box>
  )
}
