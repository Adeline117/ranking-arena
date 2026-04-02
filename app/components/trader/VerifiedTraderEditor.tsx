'use client'

/**
 * Verified Trader Profile Editor
 * Allows verified traders to edit their display_name, bio, avatar, and social links.
 * Only visible to the user who claimed the trader profile.
 */

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

interface VerifiedTraderEditorProps {
  traderId: string
  source: string
  currentData: {
    display_name?: string | null
    bio?: string | null
    avatar_url?: string | null
    twitter_url?: string | null
    telegram_url?: string | null
    discord_url?: string | null
    website_url?: string | null
  }
  onSaved?: () => void
}

export default function VerifiedTraderEditor({
  traderId: _traderId,
  source: _source,
  currentData,
  onSaved,
}: VerifiedTraderEditorProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()

  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [displayName, setDisplayName] = useState(currentData.display_name || '')
  const [bio, setBio] = useState(currentData.bio || '')
  const [twitter, setTwitter] = useState(currentData.twitter_url || '')
  const [telegram, setTelegram] = useState(currentData.telegram_url || '')
  const [discord, setDiscord] = useState(currentData.discord_url || '')
  const [website, setWebsite] = useState(currentData.website_url || '')

  const handleSave = async () => {
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
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
          display_name: displayName.trim() || null,
          bio: bio.trim() || null,
          twitter_url: twitter.trim() || null,
          telegram_url: telegram.trim() || null,
          discord_url: discord.trim() || null,
          website_url: website.trim() || null,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }

      showToast(t('verifiedTraderSaved'), 'success')
      setIsEditing(false)
      onSaved?.()
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      showToast(`${t('verifiedTraderSaveFailed')} ${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!isEditing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsEditing(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.accent.primary,
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
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
    <Box style={{
      padding: tokens.spacing[4],
      backgroundColor: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      border: `1px solid ${tokens.colors.border.primary}`,
      marginTop: tokens.spacing[3],
    }}>
      <Text style={{
        fontSize: tokens.typography.fontSize.md,
        fontWeight: 700,
        marginBottom: tokens.spacing[3],
      }}>
        {t('verifiedTraderEditProfile')}
      </Text>

      <Box style={{ display: 'grid', gap: tokens.spacing[3] }}>
        <Box>
          <label style={labelStyle}>{t('verifiedTraderDisplayName')}</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={50}
            style={inputStyle}
          />
        </Box>

        <Box>
          <label style={labelStyle}>{t('verifiedTraderBio')}</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Box>

        <Box>
          <label style={labelStyle}>{t('verifiedTraderTwitter')}</label>
          <input
            type="url"
            value={twitter}
            onChange={(e) => setTwitter(e.target.value)}
            placeholder="https://x.com/username"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label style={labelStyle}>{t('verifiedTraderTelegram')}</label>
          <input
            type="url"
            value={telegram}
            onChange={(e) => setTelegram(e.target.value)}
            placeholder="https://t.me/username"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label style={labelStyle}>{t('verifiedTraderDiscord')}</label>
          <input
            type="text"
            value={discord}
            onChange={(e) => setDiscord(e.target.value)}
            placeholder="username#1234"
            style={inputStyle}
          />
        </Box>

        <Box>
          <label style={labelStyle}>{t('verifiedTraderWebsite')}</label>
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
            style={inputStyle}
          />
        </Box>
      </Box>

      <Box style={{
        display: 'flex',
        gap: tokens.spacing[2],
        marginTop: tokens.spacing[4],
        justifyContent: 'flex-end',
      }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsEditing(false)}
          disabled={saving}
        >
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t('verifiedTraderSaving') : t('verifiedTraderSaveChanges')}
        </Button>
      </Box>
    </Box>
  )
}
