'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  type CallState,
  endCall,
  toggleMute,
  getCallDuration,
} from '@/lib/utils/peer-call'

interface VoiceCallUIProps {
  callState: CallState
  isIncoming?: boolean
  callerName: string
  callerAvatar?: string | null
  callerId: string
  onAccept?: () => void
  onReject?: () => void
  onEnd?: () => void
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// SVG Icons
function PhoneIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function PhoneOffIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

export default function VoiceCallUI({
  callState,
  isIncoming = false,
  callerName,
  callerAvatar,
  callerId,
  onAccept,
  onReject,
  onEnd,
}: VoiceCallUIProps) {
  const { t } = useLanguage()
  const [muted, setMuted] = useState(false)
  const [duration, setDuration] = useState(0)
  const [pulseAnim, setPulseAnim] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Duration timer
  useEffect(() => {
    if (callState !== 'connected') {
      setDuration(0)
      return
    }
    const interval = setInterval(() => {
      setDuration(getCallDuration())
    }, 1000)
    return () => clearInterval(interval)
  }, [callState])

  // Pulse animation for ringing
  useEffect(() => {
    if (callState === 'ringing' || callState === 'calling') {
      const interval = setInterval(() => setPulseAnim((p) => !p), 800)
      return () => clearInterval(interval)
    }
  }, [callState])

  const handleMute = useCallback(() => {
    const isMuted = toggleMute()
    setMuted(isMuted)
  }, [])

  const handleEnd = useCallback(() => {
    endCall()
    onEnd?.()
  }, [onEnd])

  if (callState === 'idle') return null

  const statusText =
    callState === 'calling'
      ? t('calling')
      : callState === 'ringing'
        ? t('incomingCall')
        : t('callDuration')

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacing[4],
        pointerEvents: 'none',
      }}
    >
      <Box
        style={{
          pointerEvents: 'auto',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 20,
          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[4],
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          backdropFilter: 'blur(16px)',
          minWidth: 320,
        }}
      >
        {/* Avatar with pulse ring */}
        <Box style={{ position: 'relative', flexShrink: 0 }}>
          <Avatar userId={callerId} name={callerName} avatarUrl={callerAvatar} size={48} />
          {(callState === 'ringing' || callState === 'calling') && (
            <Box
              style={{
                position: 'absolute',
                inset: -4,
                borderRadius: '50%',
                border: `2px solid ${tokens.colors.accent.brand}`,
                opacity: pulseAnim ? 0.6 : 0.2,
                transition: 'opacity 0.8s',
              }}
            />
          )}
        </Box>

        {/* Info */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
            {callerName}
          </Text>
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginTop: 2 }}>
            {callState === 'connected' ? formatDuration(duration) : statusText}
          </Text>
        </Box>

        {/* Controls */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
          {callState === 'ringing' && isIncoming ? (
            <>
              {/* Accept */}
              <button
                onClick={onAccept}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: 'none',
                  background: tokens.colors.accent.success,
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title={t('acceptCall')}
              >
                <PhoneIcon />
              </button>
              {/* Reject */}
              <button
                onClick={() => { handleEnd(); onReject?.() }}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: 'none',
                  background: tokens.colors.accent.error,
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title={t('rejectCall')}
              >
                <PhoneOffIcon />
              </button>
            </>
          ) : (
            <>
              {/* Mute */}
              {callState === 'connected' && (
                <button
                  onClick={handleMute}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: muted ? tokens.colors.accent.error : tokens.colors.bg.tertiary,
                    color: muted ? '#fff' : tokens.colors.text.secondary,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={t('muteAudio')}
                >
                  {muted ? <MicOffIcon /> : <MicIcon />}
                </button>
              )}
              {/* Speaker (visual only for now) */}
              {callState === 'connected' && (
                <button
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.tertiary,
                    color: tokens.colors.text.secondary,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <SpeakerIcon />
                </button>
              )}
              {/* End call */}
              <button
                onClick={handleEnd}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: 'none',
                  background: tokens.colors.accent.error,
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title={t('endCall')}
              >
                <PhoneOffIcon />
              </button>
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
