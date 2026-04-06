'use client'

import React from 'react'
import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { UploadedImage, UploadedVideo } from '../types'

interface ImageUploaderProps {
  images: UploadedImage[]
  uploading: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveImage: (index: number) => void
  onInsertImage: (url: string) => void
  isImageInContent: (url: string) => boolean
  onDragStart: (index: number) => void
  onDragOver: (e: React.DragEvent, index: number) => void
  onDragEnd: () => void
  draggedImageIndex: number | null
  t: (key: string) => string
}

export function ImageUploader({
  images, uploading, fileInputRef, onImageUpload, onRemoveImage, onInsertImage,
  isImageInContent, onDragStart, onDragOver, onDragEnd, draggedImageIndex, t,
}: ImageUploaderProps) {
  return (
    <Box>
      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
        {t('imagesOptional')}
      </Text>

      {/* Image insert guide */}
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
          {t('imageInsertStep2')} <span style={{ background: tokens.colors.accent.brand, color: tokens.colors.white, padding: '0 4px', borderRadius: 3 }}>{'\u21b5'}</span> {t('imageInsertStep2Suffix')}<br />
          {t('imageInsertStep3')}
        </Text>
      </Box>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
        multiple
        onChange={onImageUpload}
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
        {/* Uploaded image previews - draggable */}
        {images.map((image, index) => {
          const inContent = isImageInContent(image.url)
          return (
            <Box
              key={image.url}
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
              <img
                src={image.url}
                alt={`Upload ${index + 1}`}
                width={120}
                height={120}
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  pointerEvents: 'none',
                }}
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
                  top: 0,
                  right: 0,
                  display: 'flex',
                  gap: 2,
                }}
              >
                <button
                  onClick={() => onInsertImage(image.url)}
                  title={inContent ? t('reinsertAtCursor') : t('insertAtCursor')}
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
                  {'\u21b5'}
                </button>
                <button aria-label="Close"
                  onClick={() => onRemoveImage(index)}
                  title={t('delete')}
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
                  {'\u00d7'}
                </button>
              </Box>
            </Box>
          )
        })}

        {/* Upload button */}
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

interface VideoUploaderProps {
  videos: UploadedVideo[]
  videoUploading: boolean
  videoUploadProgress: number
  videoInputRef: React.RefObject<HTMLInputElement | null>
  onVideoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveVideo: () => void
  t: (key: string) => string
}

export function VideoUploader({
  videos, videoUploading, videoUploadProgress, videoInputRef,
  onVideoUpload, onRemoveVideo, t,
}: VideoUploaderProps) {
  return (
    <Box>
      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
        {t('videoOptional')}
      </Text>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska"
        onChange={onVideoUpload}
        style={{ display: 'none' }}
        id="video-upload"
      />

      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[3],
        }}
      >
        {/* Uploaded video previews */}
        {videos.map((video) => (
          <Box
            key={video.url}
            style={{
              position: 'relative',
              width: 200,
              height: 120,
              borderRadius: tokens.radius.md,
              overflow: 'hidden',
              border: ('2px solid ' + tokens.colors.accent.brand),
              background: tokens.colors.black,
            }}
          >
            <video
              src={video.url}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {/* Play icon */}
            <Box
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'var(--color-accent-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.colors.white,
                fontSize: 18,
              }}
            >
              Play
            </Box>
            {/* File size label */}
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
              {(video.fileSize / 1024 / 1024).toFixed(1)}MB
            </Box>
            {/* Delete button */}
            <button aria-label="Close"
              onClick={onRemoveVideo}
              title={t('deleteVideo')}
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                width: 24,
                height: 24,
                border: 'none',
                background: 'var(--color-accent-error)',
                color: tokens.colors.white,
                cursor: 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {'\u00d7'}
            </button>
          </Box>
        ))}

        {/* Upload button */}
        {videos.length < 1 && (
          <label
            htmlFor="video-upload"
            style={{
              width: 200,
              height: 120,
              borderRadius: tokens.radius.md,
              border: ('2px dashed ' + tokens.colors.border.primary),
              background: tokens.colors.bg.secondary,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: videoUploading ? 'not-allowed' : 'pointer',
              opacity: videoUploading ? 0.5 : 1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {videoUploading ? (
              <Box style={{ textAlign: 'center' }}>
                <Text size="xs" color="secondary">{t('uploadingImage')} {videoUploadProgress}%</Text>
                {/* Progress bar */}
                <Box
                  style={{
                    width: 150,
                    height: 4,
                    background: tokens.colors.border.primary,
                    borderRadius: 2,
                    marginTop: 8,
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    style={{
                      width: `${videoUploadProgress}%`,
                      height: '100%',
                      background: tokens.colors.accent.brand,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </Box>
              </Box>
            ) : (
              <>
                <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>Video</Text>
                <Text size="xs" color="secondary" style={{ marginTop: 4 }}>{t('addVideo')}</Text>
                <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>MP4, WebM, MOV</Text>
              </>
            )}
          </label>
        )}
      </Box>

      <Text size="xs" color="tertiary">
        {t('videoFormatSupport')}
      </Text>
    </Box>
  )
}
