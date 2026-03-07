'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { inputStyle, labelStyle } from '../styles'

interface AvatarUploadSectionProps {
  avatarUrl: string
  setAvatarUrl: (url: string) => void
  uploading: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function AvatarUploadSection({
  avatarUrl,
  setAvatarUrl,
  uploading,
  fileInputRef,
  onImageUpload,
}: AvatarUploadSectionProps) {
  const { t } = useLanguage()

  return (
    <Box>
      <label style={labelStyle}>
        {t('groupAvatar')}
      </label>
      <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {t('avatarUploadDesc')}
      </Text>

      {avatarUrl && (
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <Box style={{ position: 'relative', display: 'inline-block' }}>
            <Image
              src={avatarUrl}
              alt="Avatar preview"
              width={120}
              height={120}
              style={{
                width: 120,
                height: 120,
                borderRadius: tokens.radius.lg,
                objectFit: 'cover',
                border: ('1px solid ' + tokens.colors.border.primary),
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none'
              }}
              unoptimized
            />
            <Button aria-label="Close"
              type="button"
              variant="text"
              size="sm"
              onClick={() => setAvatarUrl('')}
              style={{
                position: 'absolute',
                top: -8,
                right: -8,
                padding: tokens.spacing[1],
                minWidth: 'auto',
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: tokens.colors.accent.error,
                color: tokens.colors.white,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
              }}
            >
              ×
            </Button>
          </Box>
        </Box>
      )}

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={onImageUpload}
            style={{ display: 'none' }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{ flexShrink: 0 }}
          >
            {uploading ? t('uploadingImage') : t('uploadImage')}
          </Button>
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Box style={{ flex: 1, height: 1, background: tokens.colors.border.primary }} />
            <Text size="xs" color="tertiary" style={{ whiteSpace: 'nowrap' }}>
              {t('orWord')}
            </Text>
            <Box style={{ flex: 1, height: 1, background: tokens.colors.border.primary }} />
          </Box>
        </Box>
        <input
          type="url"
          value={avatarUrl}
          onChange={(e) => setAvatarUrl(e.target.value)}
          placeholder="https://example.com/avatar.png"
          style={inputStyle}
        />
      </Box>
    </Box>
  )
}
