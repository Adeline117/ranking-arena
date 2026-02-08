'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  type CallState,
  endCall,
  toggleMute,
  toggleCamera,
  switchCamera,
  getCallDuration,
} from '@/lib/utils/peer-call'

interface VideoCallUIProps {
  callState: CallState
  isIncoming?: boolean
  callerName: string
  localStream?: MediaStream | null
  remoteStream?: MediaStream | null
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
function MicIcon({ off = false }: { off?: boolean }) {
  if (off) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    )
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function CameraIcon({ off = false }: { off?: boolean }) {
  if (off) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9" />
      </svg>
    )
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function SwitchCameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
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

function PhoneIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function FullscreenIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

export default function VideoCallUI({
  callState,
  isIncoming = false,
  callerName,
  localStream,
  remoteStream,
  onAccept,
  onReject,
  onEnd,
}: VideoCallUIProps) {
  const { t } = useLanguage()
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [duration, setDuration] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Attach streams to video elements
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream
    }
  }, [remoteStream])

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

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

  const handleMute = useCallback(() => {
    const isMuted = toggleMute()
    setMuted(isMuted)
  }, [])

  const handleToggleCamera = useCallback(() => {
    const isOff = toggleCamera()
    setCameraOff(isOff)
  }, [])

  const handleSwitchCamera = useCallback(async () => {
    await switchCamera()
  }, [])

  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {})
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {})
    }
  }, [])

  const handleEnd = useCallback(() => {
    endCall()
    onEnd?.()
  }, [onEnd])

  if (callState === 'idle') return null

  // Incoming call - show accept/reject before connected
  if ((callState === 'ringing') && isIncoming) {
    return (
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[6],
        }}
      >
        <Text size="lg" weight="bold" style={{ color: '#fff' }}>
          {callerName}
        </Text>
        <Text size="sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
          {t('videoCall')} - {t('incomingCall')}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[6], marginTop: tokens.spacing[4] }}>
          <button
            onClick={onAccept}
            style={{
              width: 56, height: 56, borderRadius: '50%', border: 'none',
              background: tokens.colors.accent.success, color: '#fff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title={t('acceptCall')}
          >
            <PhoneIcon />
          </button>
          <button
            onClick={() => { handleEnd(); onReject?.() }}
            style={{
              width: 56, height: 56, borderRadius: '50%', border: 'none',
              background: tokens.colors.accent.error, color: '#fff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title={t('rejectCall')}
          >
            <PhoneOffIcon />
          </button>
        </Box>
      </Box>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Remote video (full screen) */}
      <Box style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {remoteStream ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Box style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.05)',
          }}>
            <Text size="lg" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {callState === 'calling' ? t('calling') : t('ringing')}
            </Text>
          </Box>
        )}

        {/* Local video PiP */}
        {localStream && (
          <Box style={{
            position: 'absolute',
            top: 16,
            right: 16,
            width: 120,
            height: 160,
            borderRadius: 12,
            overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.3)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            />
          </Box>
        )}

        {/* Duration overlay */}
        {callState === 'connected' && (
          <Box style={{
            position: 'absolute',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 20,
            padding: '4px 16px',
          }}>
            <Text size="sm" style={{ color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
              {formatDuration(duration)}
            </Text>
          </Box>
        )}

        {/* Caller name */}
        <Box style={{
          position: 'absolute',
          bottom: 80,
          left: '50%',
          transform: 'translateX(-50%)',
        }}>
          <Text size="base" weight="bold" style={{ color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
            {callerName}
          </Text>
        </Box>
      </Box>

      {/* Controls bar */}
      <Box style={{
        display: 'flex',
        justifyContent: 'center',
        gap: tokens.spacing[4],
        padding: `${tokens.spacing[4]} ${tokens.spacing[6]}`,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(8px)',
      }}>
        {/* Mute */}
        <button
          onClick={handleMute}
          style={{
            width: 48, height: 48, borderRadius: '50%', border: 'none',
            background: muted ? tokens.colors.accent.error : 'rgba(255,255,255,0.2)',
            color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title={t('muteAudio')}
        >
          <MicIcon off={muted} />
        </button>

        {/* Toggle camera */}
        <button
          onClick={handleToggleCamera}
          style={{
            width: 48, height: 48, borderRadius: '50%', border: 'none',
            background: cameraOff ? tokens.colors.accent.error : 'rgba(255,255,255,0.2)',
            color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title={t('toggleCamera')}
        >
          <CameraIcon off={cameraOff} />
        </button>

        {/* Switch camera */}
        <button
          onClick={handleSwitchCamera}
          style={{
            width: 48, height: 48, borderRadius: '50%', border: 'none',
            background: 'rgba(255,255,255,0.2)',
            color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <SwitchCameraIcon />
        </button>

        {/* End call */}
        <button
          onClick={handleEnd}
          style={{
            width: 56, height: 56, borderRadius: '50%', border: 'none',
            background: tokens.colors.accent.error,
            color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title={t('endCall')}
        >
          <PhoneOffIcon />
        </button>

        {/* Fullscreen */}
        <button
          onClick={handleFullscreen}
          style={{
            width: 48, height: 48, borderRadius: '50%', border: 'none',
            background: 'rgba(255,255,255,0.2)',
            color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <FullscreenIcon />
        </button>
      </Box>
    </div>
  )
}
