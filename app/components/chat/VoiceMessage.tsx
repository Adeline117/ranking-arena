'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

interface VoiceMessageProps {
  url: string
  duration: number // seconds
}

export default function VoiceMessage({ url, duration }: VoiceMessageProps) {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(duration)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // Generate pseudo-random waveform bars
  const bars = useRef(
    Array.from({ length: 30 }, () => 0.2 + Math.random() * 0.8)
  ).current

  useEffect(() => {
    const audio = new Audio(url)
    audioRef.current = audio

    const handleLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setAudioDuration(audio.duration)
      }
    }
    const handleEnded = () => {
      setPlaying(false)
      setCurrentTime(0)
    }

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('ended', handleEnded)
      audio.pause()
      audio.src = ''
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [url])

  const updateProgress = useCallback(() => {
    if (audioRef.current && playing) {
      setCurrentTime(audioRef.current.currentTime)
      animFrameRef.current = requestAnimationFrame(updateProgress)
    }
  }, [playing])

  useEffect(() => {
    if (playing) {
      animFrameRef.current = requestAnimationFrame(updateProgress)
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [playing, updateProgress])

  const togglePlay = () => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play()
      setPlaying(true)
    }
  }

  const handleBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !audioDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = ratio * audioDuration
    setCurrentTime(audioRef.current.currentTime)
  }

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: tokens.spacing[2],
      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      minWidth: 200,
      maxWidth: 300,
    }}>
      {/* Play/Pause button */}
      <button
        onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: 'none',
          background: tokens.colors.accent.brand,
          color: tokens.colors.white,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,4 20,12 6,20" />
          </svg>
        )}
      </button>

      {/* Waveform */}
      <div
        onClick={handleBarClick}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          height: 28,
          cursor: 'pointer',
        }}
      >
        {bars.map((h, i) => {
          const barProgress = i / bars.length
          const isPlayed = barProgress <= progress
          return (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${h * 100}%`,
                borderRadius: 1,
                background: isPlayed ? tokens.colors.accent.brand : tokens.colors.border.primary,
                transition: 'background 0.1s',
                minWidth: 2,
              }}
            />
          )
        })}
      </div>

      {/* Duration */}
      <span style={{
        fontSize: tokens.typography.fontSize.xs,
        color: tokens.colors.text.secondary,
        minWidth: 32,
        textAlign: 'right',
        flexShrink: 0,
      }}>
        {playing ? formatTime(currentTime) : formatTime(audioDuration)}
      </span>
    </div>
  )
}
