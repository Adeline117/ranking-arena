'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { UploadedImage } from '../types'

interface ImageUploaderProps {
  images: UploadedImage[]
  uploading: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemove: (index: number) => void
  onInsert: (url: string) => void
  language: string
  t: (key: string) => string
}

export function ImageUploader({
  images, uploading, fileInputRef,
  onUpload, onRemove, onInsert,
  language: _language, t,
}: ImageUploaderProps): React.ReactElement {
  return (
    <Box>
      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
        {t('imagesOptional')}
      </Text>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
        multiple
        onChange={onUpload}
        style={{ display: 'none' }}
        id="image-upload"
      />

      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[3],
        }}
      >
        {images.map((image, index) => (
          <Box
            key={index}
            style={{
              position: 'relative',
              width: 100,
              height: 100,
              borderRadius: tokens.radius.md,
              overflow: 'hidden',
              border: ('1px solid ' + tokens.colors.border.primary),
            }}
          >
            <img
              src={image.url}
              alt={`Upload ${index + 1}`}
              width={120}
              height={120}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
            <Box
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                display: 'flex',
                gap: 2,
              }}
            >
              <button
                onClick={() => onInsert(image.url)}
                title={t('imageInserted') || t('insertToContent')}
                style={{
                  width: 24,
                  height: 24,
                  border: 'none',
                  background: 'var(--color-accent-primary)',
                  color: tokens.colors.white,
                  cursor: 'pointer',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ↵
              </button>
              <button aria-label="Close"
                onClick={() => onRemove(index)}
                title={t('deleteButton')}
                style={{
                  width: 24,
                  height: 24,
                  border: 'none',
                  background: 'var(--color-accent-error)',
                  color: tokens.colors.white,
                  cursor: 'pointer',
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                x
              </button>
            </Box>
          </Box>
        ))}

        {images.length < 9 && (
          <label
            htmlFor="image-upload"
            style={{
              width: 100,
              height: 100,
              borderRadius: tokens.radius.md,
              border: ('2px dashed ' + tokens.colors.border.primary),
              background: tokens.colors.bg.secondary,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: uploading ? 'not-allowed' : 'pointer',
              opacity: uploading ? 0.5 : 1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {uploading ? (
              <Text size="xs" color="secondary">{t('uploadingImage')}</Text>
            ) : (
              <>
                <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>+</Text>
                <Text size="xs" color="secondary">{t('addImage')}</Text>
              </>
            )}
          </label>
        )}
      </Box>

      <Text size="xs" color="tertiary">
        {t('imageSupport')}
      </Text>
    </Box>
  )
}
