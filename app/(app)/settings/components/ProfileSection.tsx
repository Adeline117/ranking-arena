'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SectionCard, getInputStyle } from './shared'
import { validateHandle, MAX_BIO_LENGTH, MAX_HANDLE_LENGTH } from '../validation'

interface ProfileSectionProps {
  userId: string | null
  email: string | null
  handle: string
  setHandle: (v: string) => void
  bio: string
  setBio: (v: string) => void
  previewUrl: string | null
  coverPreviewUrl: string | null
  coverUrl: string | null
  initialHandle: string | null
  handleAvailable: boolean | null
  checkingHandle: boolean
  touchedHandle: boolean
  markTouched: () => void
  onAvatarChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onCoverChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveCover: () => void
}

export const ProfileSection = React.memo(function ProfileSection({
  userId,
  email,
  handle,
  setHandle,
  bio,
  setBio,
  previewUrl,
  coverPreviewUrl,
  coverUrl,
  initialHandle,
  handleAvailable,
  checkingHandle,
  touchedHandle,
  markTouched,
  onAvatarChange,
  onCoverChange,
  onRemoveCover,
}: ProfileSectionProps) {
  const { t } = useLanguage()
  const handleValidation = validateHandle(handle, t)

  return (
    <SectionCard id="profile" title={t('profileSection')} description={t('profileDescription')}>
      {/* Avatar */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[5] }}>
        {userId ? (
          <Avatar
            userId={userId}
            name={handle || email}
            avatarUrl={previewUrl}
            size={80}
            style={{
              borderRadius: tokens.radius.xl,
              border: `2px solid ${tokens.colors.border.primary}`,
            }}
          />
        ) : (
          <Box
            style={{
              width: 80,
              height: 80,
              borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.tertiary,
              border: `2px solid ${tokens.colors.border.primary}`,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <Text size="2xl" weight="black" style={{ color: tokens.colors.text.secondary }}>
              {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
            </Text>
          </Box>
        )}

        <Box>
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={onAvatarChange}
            style={{ display: 'none' }}
            id="avatar-input"
          />
          <label
            htmlFor="avatar-input"
            style={{
              display: 'inline-block',
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              cursor: 'pointer',
              fontWeight: tokens.typography.fontWeight.bold,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('changeAvatar')}
          </label>
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], display: 'block' }}>
            {t('avatarFormatHint')}
          </Text>
        </Box>
      </Box>

      {/* Cover Image */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('coverImage')}
        </Text>
        <Box
          style={{
            width: '100%',
            height: 120,
            borderRadius: tokens.radius.lg,
            background: (coverPreviewUrl || coverUrl)
              ? `url(${coverPreviewUrl || coverUrl}) center/cover no-repeat`
              : `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
            border: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: tokens.spacing[2],
          }}
        >
          {!coverPreviewUrl && !coverUrl && (
            <Text size="sm" color="tertiary">{t('noCoverImage')}</Text>
          )}
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={onCoverChange}
            style={{ display: 'none' }}
            id="cover-input"
          />
          <label
            htmlFor="cover-input"
            style={{
              display: 'inline-block',
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              cursor: 'pointer',
              fontWeight: tokens.typography.fontWeight.bold,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('changeCover')}
          </label>
          {(coverPreviewUrl || coverUrl) && (
            <button
              onClick={onRemoveCover}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.accent.error}40`,
                background: 'transparent',
                color: tokens.colors.accent.error,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('remove')}
            </button>
          )}
          <Text size="xs" color="tertiary">
            {t('coverSizeHint')}
          </Text>
        </Box>
      </Box>

      {/* Handle */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('username')}
        </Text>
        {initialHandle && (
          <Box
            style={{
              marginBottom: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" color="tertiary" style={{ marginBottom: 2 }}>
              {t('currentUsername') || 'Current username'}
            </Text>
            <Text size="sm" weight="bold">
              @{initialHandle}
            </Text>
          </Box>
        )}
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value.slice(0, MAX_HANDLE_LENGTH))}
          onBlur={markTouched}
          placeholder={t('setUsername')}
          autoComplete="username"
          aria-label={t('username')}
          style={getInputStyle(touchedHandle && !handleValidation.valid)}
        />
        <Box style={{ display: 'flex', justifyContent: 'space-between', marginTop: tokens.spacing[1] }}>
          <Box>
            {touchedHandle && handle && !handleValidation.valid && (
              <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                {handleValidation.message}
              </Text>
            )}
            {touchedHandle && handle && handleValidation.valid && checkingHandle && (
              <Text size="xs" color="tertiary">
                {t('checking')}
              </Text>
            )}
            {touchedHandle && handle && handleValidation.valid && !checkingHandle && handleAvailable === true && (
              <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                {t('usernameAvailable')}
              </Text>
            )}
            {touchedHandle && handle && handleValidation.valid && !checkingHandle && handleAvailable === false && (
              <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                {t('usernameTaken')}
              </Text>
            )}
          </Box>
          <Text size="xs" color="tertiary">
            {handle.length}/{MAX_HANDLE_LENGTH}
          </Text>
        </Box>
      </Box>

      {/* Bio */}
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('personalBio')}
        </Text>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, MAX_BIO_LENGTH))}
          placeholder={t('introduceSelf')}
          aria-label={t('personalBio')}
          rows={4}
          style={{
            ...getInputStyle(),
            resize: 'vertical',
            minHeight: '80px',
          }}
        />
        <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[1] }}>
          <Text
            size="xs"
            style={{
              color: bio.length > MAX_BIO_LENGTH * 0.9
                ? tokens.colors.accent.warning
                : tokens.colors.text.tertiary
            }}
          >
            {bio.length}/{MAX_BIO_LENGTH}
          </Text>
        </Box>
      </Box>
    </SectionCard>
  )
})
