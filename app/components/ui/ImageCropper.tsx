'use client'

import { useState, useCallback } from 'react'
import Cropper from 'react-easy-crop'
import type { Area, Point } from 'react-easy-crop'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text, Button } from '@/app/components/base'
import { logger } from '@/lib/logger'

interface ImageCropperProps {
  imageSrc: string
  onCropComplete: (croppedBlob: Blob) => void
  onCancel: () => void
  aspectRatio?: number
  cropShape?: 'rect' | 'round'
  title?: string
  onError?: (message: string) => void
}

// Create image from URL
function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', (error) => reject(error))
    image.crossOrigin = 'anonymous'
    image.src = url
  })
}

// Get cropped image as blob
async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Area,
  aspectRatio: number = 1,
  maxWidth: number = 800
): Promise<Blob> {
  const image = await createImage(imageSrc)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error('No 2d context')
  }

  // Calculate output dimensions maintaining aspect ratio
  // Avatars (1:1): 400px, covers (wide): 1200px, others: maxWidth
  const effectiveMax = aspectRatio === 1 ? 400 : aspectRatio > 2 ? 1200 : maxWidth
  let outputWidth = Math.min(pixelCrop.width, effectiveMax)
  let outputHeight = outputWidth / aspectRatio

  // Set canvas size
  canvas.width = outputWidth
  canvas.height = outputHeight

  // Draw cropped image
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputWidth,
    outputHeight
  )

  // Convert to WebP (smaller size, better quality) with JPEG fallback
  return new Promise((resolve, reject) => {
    const tryFormat = (format: string, quality: number) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            // If blob is still > 500KB, re-encode at lower quality
            if (blob.size > 512_000 && quality > 0.6) {
              canvas.toBlob(
                (compressed) => resolve(compressed || blob),
                format,
                quality - 0.15
              )
            } else {
              resolve(blob)
            }
          } else if (format === 'image/webp') {
            // WebP not supported — fallback to JPEG
            tryFormat('image/jpeg', quality)
          } else {
            reject(new Error('Canvas is empty'))
          }
        },
        format,
        quality
      )
    }
    tryFormat('image/webp', 0.85)
  })
}

export function ImageCropper({
  imageSrc,
  onCropComplete,
  onCancel,
  aspectRatio = 1,
  cropShape = 'round',
  title,
  onError,
}: ImageCropperProps) {
  const { t } = useLanguage()
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [processing, setProcessing] = useState(false)

  const onCropAreaComplete = useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels)
    },
    []
  )

  const handleConfirm = async () => {
    if (!croppedAreaPixels) {
      onError?.(t('noCropAreaSelected') || 'Please select an area to crop')
      return
    }

    setProcessing(true)
    try {
      const croppedBlob = await getCroppedImg(imageSrc, croppedAreaPixels, aspectRatio)
      onCropComplete(croppedBlob)
    } catch (error) {
      logger.error('Error cropping image:', error)
      const errorMessage = error instanceof Error ? error.message : t('cropFailed') || 'Failed to crop image'
      onError?.(errorMessage)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-backdrop-heavy)',
        backdropFilter: tokens.glass.blur.xs,
        WebkitBackdropFilter: tokens.glass.blur.xs,
      }}
    >
      <Box
        style={{
          width: '90%',
          maxWidth: 500,
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          overflow: 'hidden',
          boxShadow: tokens.shadow.xl,
        }}
      >
        {/* Header */}
        <Box
          style={{
            padding: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="md" weight="semibold">
            {title || t('cropImage')}
          </Text>
        </Box>

        {/* Cropper Area */}
        <Box
          style={{
            position: 'relative',
            width: '100%',
            height: 350,
            background: tokens.colors.bg.tertiary,
          }}
        >
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspectRatio}
            cropShape={cropShape}
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropAreaComplete}
            style={{
              containerStyle: {
                background: tokens.colors.bg.tertiary,
              },
            }}
          />
        </Box>

        {/* Zoom Slider */}
        <Box
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
            }}
          >
            <Text size="xs" color="tertiary" style={{ whiteSpace: 'nowrap' }}>
              {t('zoom')}
            </Text>
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={zoom}
              aria-label={t('zoom')}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{
                flex: 1,
                height: 4,
                appearance: 'none',
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.full,
                cursor: 'pointer',
              }}
            />
          </Box>
        </Box>

        {/* Actions */}
        <Box
          style={{
            padding: tokens.spacing[4],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: tokens.spacing[3],
          }}
        >
          <Button variant="secondary" onClick={onCancel} disabled={processing}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={processing || !croppedAreaPixels}
          >
            {processing ? t('processing') : t('confirm')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
