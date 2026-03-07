'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { UploadedVideo } from '../types'

interface VideoUploaderProps {
  videos: UploadedVideo[]
  videoUploading: boolean
  videoUploadProgress: number
  videoInputRef: React.RefObject<HTMLInputElement | null>
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
  t: (key: string) => string
}

export function VideoUploader({
  videos, videoUploading, videoUploadProgress,
  videoInputRef, onUpload, onRemove, t,
}: VideoUploaderProps): React.ReactElement {
  return (
    <Box>
      <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
        {t('videoOptional')}
      </Text>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska"
        onChange={onUpload}
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
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
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
              {video.fileSize ? (video.fileSize / 1024 / 1024).toFixed(1) : '?'}MB
            </Box>
            {/* Delete button */}
            <button aria-label="Close"
              onClick={onRemove}
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
              x
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
                <Text size="xs" color="secondary">{t('uploadingProgress').replace('{percent}', String(videoUploadProgress))}</Text>
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
