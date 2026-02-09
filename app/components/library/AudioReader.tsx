'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { TTSController, TTSState, splitSentences, getVoices, isChinese } from '@/lib/utils/tts-reader'

type AudioReaderProps = {
  text: string
  isZh: boolean
  themeIsDark: boolean
  onClose: () => void
}

export default function AudioReader({ text, isZh, themeIsDark, onClose }: AudioReaderProps) {
  const [ttsState, setTtsState] = useState<TTSState>('idle')
  const [currentSentence, setCurrentSentence] = useState(0)
  const [rate, setRate] = useState(1.0)
  const [pitch, _setPitch] = useState(1.0)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>('')
  const sentenceListRef = useRef<HTMLDivElement>(null)

  const sentences = useMemo(() => splitSentences(text), [text])

  const controllerRef = useRef<TTSController | null>(null)

  // Init controller
  useEffect(() => {
    const ctrl = new TTSController({
      rate,
      pitch,
      voiceURI: selectedVoiceURI || undefined,
      onSentenceChange: (idx) => setCurrentSentence(idx),
      onEnd: () => setCurrentSentence(0),
      onStateChange: (s) => setTtsState(s),
    })
    ctrl.setText(text)
    controllerRef.current = ctrl

    return () => {
      ctrl.stop()
    }
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  // Update options when rate/pitch/voice change
  useEffect(() => {
    controllerRef.current?.updateOptions({
      rate,
      pitch,
      voiceURI: selectedVoiceURI || undefined,
    })
  }, [rate, pitch, selectedVoiceURI])

  // Load voices
  useEffect(() => {
    const loadVoices = () => {
      const v = getVoices()
      setVoices(v)
      // Auto-select Chinese voice if text is Chinese
      if (!selectedVoiceURI && v.length > 0) {
        if (isChinese(text)) {
          const zh = v.find(voice => voice.lang.startsWith('zh') && voice.localService)
            || v.find(voice => voice.lang.startsWith('zh'))
          if (zh) setSelectedVoiceURI(zh.voiceURI)
        }
      }
    }
    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices
    return () => { window.speechSynthesis.onvoiceschanged = null }
  }, [text, selectedVoiceURI])

  // Auto-scroll to current sentence
  useEffect(() => {
    const container = sentenceListRef.current
    if (!container) return
    const el = container.querySelector(`[data-sentence="${currentSentence}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentSentence])

  const handlePlayPause = useCallback(() => {
    const ctrl = controllerRef.current
    if (!ctrl) return
    if (ttsState === 'playing') {
      ctrl.pause()
    } else {
      ctrl.play()
    }
  }, [ttsState])

  const handleStop = useCallback(() => {
    controllerRef.current?.stop()
    setCurrentSentence(0)
  }, [])

  const progress = sentences.length > 0 ? ((currentSentence) / sentences.length) * 100 : 0

  // Styles
  const panelBg = themeIsDark ? '#1e1e36' : '#fff'
  const panelText = themeIsDark ? '#d4d4d8' : '#1a1a1a'
  const panelBorder = themeIsDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const panelSubtle = themeIsDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
  const accent = 'var(--color-accent-primary, #6366f1)'
  const highlightBg = themeIsDark ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.12)'

  // Voice display name
  const voiceLabel = (v: SpeechSynthesisVoice) => {
    const lang = v.lang.replace('_', '-')
    return `${v.name} (${lang})`
  }

  // Group voices: Chinese first, then others
  const groupedVoices = useMemo(() => {
    const zh = voices.filter(v => v.lang.startsWith('zh') || v.lang.startsWith('cmn'))
    const en = voices.filter(v => v.lang.startsWith('en'))
    const others = voices.filter(v =>
      !v.lang.startsWith('zh') && !v.lang.startsWith('cmn') && !v.lang.startsWith('en')
    )
    return { zh, en, others }
  }, [voices])

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      background: panelBg, color: panelText, zIndex: 200,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: `1px solid ${panelBorder}`,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {isZh ? '朗读模式' : 'Audio Reader'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {ttsState === 'playing' && (
            <span style={{ fontSize: 12, opacity: 0.5 }}>
              {isZh ? '朗读中' : 'Reading'}
              {' '}{currentSentence + 1}/{sentences.length}
            </span>
          )}
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: panelText,
            cursor: 'pointer', padding: 4, opacity: 0.5,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 3, background: panelSubtle, flexShrink: 0,
      }}>
        <div style={{
          height: '100%', width: `${progress}%`,
          background: accent, transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Sentence list with highlighting */}
      <div ref={sentenceListRef} style={{
        flex: 1, overflow: 'auto', padding: '16px 20px',
        lineHeight: 2, fontSize: 15,
      }}>
        {sentences.map((s, i) => (
          <span
            key={i}
            data-sentence={i}
            onClick={() => {
              controllerRef.current?.seekTo(i)
            }}
            style={{
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: 4,
              background: i === currentSentence && ttsState !== 'idle' ? highlightBg : 'transparent',
              fontWeight: i === currentSentence && ttsState !== 'idle' ? 600 : 400,
              transition: 'background 0.2s, font-weight 0.2s',
              display: 'inline',
            }}
          >
            {s}
          </span>
        ))}
      </div>

      {/* Controls */}
      <div style={{
        borderTop: `1px solid ${panelBorder}`,
        padding: '12px 16px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {/* Voice selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>
            {isZh ? '语音' : 'Voice'}
          </span>
          <select
            value={selectedVoiceURI}
            onChange={e => setSelectedVoiceURI(e.target.value)}
            style={{
              flex: 1, padding: '6px 8px', borderRadius: 6,
              border: `1px solid ${panelBorder}`, background: panelSubtle,
              color: panelText, fontSize: 12, outline: 'none',
            }}
          >
            <option value="">{isZh ? '自动选择' : 'Auto'}</option>
            {groupedVoices.zh.length > 0 && (
              <optgroup label={isZh ? '中文' : 'Chinese'}>
                {groupedVoices.zh.map(v => (
                  <option key={v.voiceURI} value={v.voiceURI}>{voiceLabel(v)}</option>
                ))}
              </optgroup>
            )}
            {groupedVoices.en.length > 0 && (
              <optgroup label={isZh ? '英文' : 'English'}>
                {groupedVoices.en.map(v => (
                  <option key={v.voiceURI} value={v.voiceURI}>{voiceLabel(v)}</option>
                ))}
              </optgroup>
            )}
            {groupedVoices.others.length > 0 && (
              <optgroup label={isZh ? '其他' : 'Other'}>
                {groupedVoices.others.map(v => (
                  <option key={v.voiceURI} value={v.voiceURI}>{voiceLabel(v)}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Speed control */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>
            {isZh ? '速度' : 'Speed'}
          </span>
          <input
            type="range" min="0.5" max="3" step="0.1" value={rate}
            onChange={e => setRate(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: accent }}
          />
          <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: 'right' }}>
            {rate.toFixed(1)}x
          </span>
        </div>

        {/* Playback buttons */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          {/* Skip back */}
          <button onClick={() => controllerRef.current?.skipBackward()} style={{
            width: 36, height: 36, borderRadius: '50%', border: `1px solid ${panelBorder}`,
            background: 'transparent', color: panelText, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
          </button>

          {/* Play/Pause */}
          <button onClick={handlePlayPause} style={{
            width: 48, height: 48, borderRadius: '50%', border: 'none',
            background: accent, color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20,
          }}>
            {ttsState === 'playing' ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            )}
          </button>

          {/* Stop */}
          <button onClick={handleStop} style={{
            width: 36, height: 36, borderRadius: '50%', border: `1px solid ${panelBorder}`,
            background: 'transparent', color: panelText, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
            </svg>
          </button>

          {/* Skip forward */}
          <button onClick={() => controllerRef.current?.skipForward()} style={{
            width: 36, height: 36, borderRadius: '50%', border: `1px solid ${panelBorder}`,
            background: 'transparent', color: panelText, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
