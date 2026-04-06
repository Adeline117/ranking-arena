'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import type { UploadedImage } from '../_hooks/useEditPost'

interface ImageUploadSectionProps {
  images: UploadedImage[]
  uploading: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  draggedImageIndex: number | null
  isImageInContent: (url: string) => boolean
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onInsertImage: (url: string) => void
  onRemoveImage: (index: number) => void
  onDragStart: (index: number) => void
  onDragOver: (e: React.DragEvent, index: number) => void
  onDragEnd: () => void
  t: (key: string) => string
}

export function ImageUploadSection({
  images,
  uploading,
  fileInputRef,
  draggedImageIndex,
  isImageInContent,
  onImageUpload,
  onInsertImage,
  onRemoveImage,
  onDragStart,
  onDragOver,
  onDragEnd,
  t,
}: ImageUploadSectionProps) {
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
        onChange={onImageUpload}
        style={{ display: 'none' }}
      />

      {/* Usage guide */}
      <Box
        style={{
          padding: tokens.spacing[3],
          marginBottom: tokens.spacing[3],
          background: 'var(--color-accent-primary-10)',
          borderRadius: tokens.radius.md,
          border: ('1px dashed ' + tokens.colors.accent.brand),
        }}
      >
        <Text size="xs" color="secondary" style={{ display: 'block', marginBottom: 4 }}>
          <strong>{t('imageInsertGuideTitle')}</strong>
        </Text>
        <Text size="xs" color="tertiary" style={{ display: 'block', lineHeight: 1.6 }}>
          {t('imageInsertStep1')}<br />
          {t('imageInsertStep2')} <span style={{ background: tokens.colors.accent.brand, color: tokens.colors.white, padding: '0 4px', borderRadius: 3 }}>↵</span> {t('imageInsertStep2Suffix')}<br />
          {t('imageInsertStep3')}
        </Text>
      </Box>

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
        {images.map((img, index) => {
          const inContent = isImageInContent(img.url)
          return (
            <Box
              key={img.url}
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDragEnd={onDragEnd}
              style={{
                position: 'relative',
                width: 100,
                height: 100,
                borderRadius: tokens.radius.md,
                overflow: 'hidden',
                border: inContent
                  ? ('2px solid ' + tokens.colors.accent.brand)
                  : draggedImageIndex === index
                    ? ('2px solid ' + tokens.colors.accent.brand)
                    : ('1px solid ' + tokens.colors.border.primary),
                cursor: 'grab',
                opacity: draggedImageIndex === index ? 0.7 : 1,
                transition: `all ${tokens.transition.base}`,
              }}
            >
              <Image
                src={img.url}
                alt={img.fileName}
                width={120}
                height={120}
                draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                unoptimized
              />
              {/* Inserted badge */}
              {inContent && (
                <Box
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    background: 'var(--color-accent-primary)',
                    color: tokens.colors.white,
                    fontSize: 10,
                    textAlign: 'center',
                    padding: '2px 0',
                  }}
                >
                  {t('inserted')}
                </Box>
              )}
              <Box
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  display: 'flex',
                  gap: 4,
                }}
              >
                <button
                  type="button"
                  onClick={() => onInsertImage(img.url)}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'var(--color-accent-primary)',
                    color: tokens.colors.white,
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={inContent ? t('reinsertAtCursor') : t('insertAtCursor')}
                >
                  ↵
                </button>
                <button aria-label="Close"
                  type="button"
                  onClick={() => onRemoveImage(index)}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'var(--color-accent-error)',
                    color: tokens.colors.white,
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={t('deleteImage')}
                >
                  ×
                </button>
              </Box>
            </Box>
          )
        })}

        {images.length < 9 && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              width: 100,
              height: 100,
              borderRadius: tokens.radius.md,
              border: ('2px dashed ' + tokens.colors.border.primary),
              background: 'transparent',
              color: tokens.colors.text.tertiary,
              fontSize: 32,
              cursor: uploading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: uploading ? 0.5 : 1,
            }}
          >
            {uploading ? '...' : '+'}
          </button>
        )}
      </Box>
    </Box>
  )
}
