'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface VoiceRecorderProps {
  onVoiceSent: (url: string, duration: number) => void
  disabled?: boolean
}

export default function VoiceRecorder({ onVoiceSent, disabled }: VoiceRecorderProps) {
  const { t } = useLanguage()
  const [recording, setRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [uploading, setUploading] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      })
      mediaRecorderRef.current = mediaRecorder
      chunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop())
        if (timerRef.current) clearInterval(timerRef.current)

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const recordedDuration = Math.round((Date.now() - startTimeRef.current) / 1000)

        if (recordedDuration < 1) return // too short

        setUploading(true)
        try {
          const fileName = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webm`
          const { data, error } = await supabase.storage
            .from('voice-messages')
            .upload(fileName, blob, { contentType: 'audio/webm' })

          if (error) throw error

          const { data: urlData } = supabase.storage
            .from('voice-messages')
            .getPublicUrl(data.path)

          onVoiceSent(urlData.publicUrl, recordedDuration)
        } catch (err) {
          logger.error('Voice upload failed:', err)
        } finally {
          setUploading(false)
          setDuration(0)
        }
      }

      mediaRecorder.start(100)
      startTimeRef.current = Date.now()
      setRecording(true)
      setDuration(0)
      timerRef.current = setInterval(() => {
        setDuration(Math.round((Date.now() - startTimeRef.current) / 1000))
      }, 1000)
    } catch (err) {
      logger.error('Microphone access denied:', err)
    }
  }, [onVoiceSent])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
      setRecording(false)
    }
  }, [])

  const formatDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
      {recording && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
          background: 'var(--color-accent-error-15)',
          borderRadius: tokens.radius.full,
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.accent.error,
        }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tokens.colors.accent.error,
            animation: 'pulse 1s infinite',
          }} />
          {formatDuration(duration)}
        </div>
      )}
      <button
        onClick={recording ? stopRecording : startRecording}
        disabled={disabled || uploading}
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: recording ? tokens.colors.accent.error : tokens.colors.bg.secondary,
          color: recording ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
          cursor: disabled || uploading ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: tokens.transition.fast,
          opacity: disabled || uploading ? 0.5 : 1,
          flexShrink: 0,
        }}
        title={recording ? t('停止录音') : t('语音消息')}
      >
        {uploading ? (
          <svg width="20" height="20" viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite' }}>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="31.4 31.4" />
          </svg>
        ) : recording ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </button>
    </div>
  )
}
