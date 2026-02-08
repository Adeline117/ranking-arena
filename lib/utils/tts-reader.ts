/**
 * TTS Reader - Web Speech API
 * Text chunking, sentence splitting, voice selection, speed/pitch control
 */

// Sentence splitting: handles Chinese and English punctuation
export function splitSentences(text: string): string[] {
  if (!text.trim()) return []
  // Split on Chinese/English sentence-ending punctuation, keeping the delimiter
  const raw = text.split(/(?<=[。！？；\.\!\?\;…])\s*/)
  const sentences: string[] = []
  for (const s of raw) {
    const trimmed = s.trim()
    if (trimmed) sentences.push(trimmed)
  }
  // If no sentence delimiters found, split by newlines or return as-is
  if (sentences.length <= 1 && text.length > 200) {
    const byLine = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
    if (byLine.length > 1) return byLine
  }
  return sentences.length > 0 ? sentences : [text.trim()]
}

// Split text into paragraphs
export function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

// Detect if text is primarily Chinese
export function isChinese(text: string): boolean {
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const total = text.replace(/\s/g, '').length
  return total > 0 && chineseChars / total > 0.3
}

// Get available voices, optionally filtered
export function getVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis.getVoices()
}

// Get Chinese voices
export function getChineseVoices(): SpeechSynthesisVoice[] {
  return getVoices().filter(v =>
    v.lang.startsWith('zh') || v.lang.startsWith('cmn')
  )
}

// Pick best voice for given text
export function pickVoice(text: string, preferredUri?: string): SpeechSynthesisVoice | null {
  const voices = getVoices()
  if (!voices.length) return null

  // Preferred voice
  if (preferredUri) {
    const found = voices.find(v => v.voiceURI === preferredUri)
    if (found) return found
  }

  const wantChinese = isChinese(text)

  if (wantChinese) {
    const zhVoices = getChineseVoices()
    // Prefer local/premium voices
    const premium = zhVoices.find(v => v.localService)
    if (premium) return premium
    if (zhVoices.length > 0) return zhVoices[0]
  }

  // English fallback
  const enVoices = voices.filter(v => v.lang.startsWith('en'))
  const enLocal = enVoices.find(v => v.localService)
  if (enLocal) return enLocal
  if (enVoices.length > 0) return enVoices[0]

  return voices[0]
}

// TTS State
export type TTSState = 'idle' | 'playing' | 'paused'

export type TTSOptions = {
  rate: number       // 0.5 - 3.0
  pitch: number      // 0.5 - 2.0
  voiceURI?: string
  onSentenceChange?: (index: number) => void
  onEnd?: () => void
  onStateChange?: (state: TTSState) => void
}

export class TTSController {
  private sentences: string[] = []
  private currentIndex = 0
  private state: TTSState = 'idle'
  private options: TTSOptions
  private utterance: SpeechSynthesisUtterance | null = null

  constructor(options: TTSOptions) {
    this.options = options
  }

  get currentSentenceIndex(): number {
    return this.currentIndex
  }

  get totalSentences(): number {
    return this.sentences.length
  }

  get currentState(): TTSState {
    return this.state
  }

  setText(text: string) {
    this.stop()
    this.sentences = splitSentences(text)
    this.currentIndex = 0
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.options = { ...this.options, ...opts }
  }

  play() {
    if (this.state === 'paused') {
      window.speechSynthesis.resume()
      this.setState('playing')
      return
    }
    if (this.sentences.length === 0) return
    this.speakCurrent()
  }

  pause() {
    if (this.state === 'playing') {
      window.speechSynthesis.pause()
      this.setState('paused')
    }
  }

  stop() {
    window.speechSynthesis.cancel()
    this.currentIndex = 0
    this.utterance = null
    this.setState('idle')
  }

  skipForward() {
    if (this.currentIndex < this.sentences.length - 1) {
      window.speechSynthesis.cancel()
      this.currentIndex++
      this.speakCurrent()
    }
  }

  skipBackward() {
    if (this.currentIndex > 0) {
      window.speechSynthesis.cancel()
      this.currentIndex--
      this.speakCurrent()
    }
  }

  seekTo(index: number) {
    if (index >= 0 && index < this.sentences.length) {
      window.speechSynthesis.cancel()
      this.currentIndex = index
      this.speakCurrent()
    }
  }

  private speakCurrent() {
    if (this.currentIndex >= this.sentences.length) {
      this.setState('idle')
      this.options.onEnd?.()
      return
    }

    const text = this.sentences[this.currentIndex]
    const utt = new SpeechSynthesisUtterance(text)
    utt.rate = this.options.rate
    utt.pitch = this.options.pitch

    const voice = pickVoice(text, this.options.voiceURI)
    if (voice) utt.voice = voice

    utt.onend = () => {
      this.currentIndex++
      if (this.currentIndex < this.sentences.length) {
        this.options.onSentenceChange?.(this.currentIndex)
        this.speakCurrent()
      } else {
        this.setState('idle')
        this.options.onEnd?.()
      }
    }

    utt.onerror = () => {
      this.setState('idle')
    }

    this.utterance = utt
    this.options.onSentenceChange?.(this.currentIndex)
    this.setState('playing')
    window.speechSynthesis.speak(utt)
  }

  private setState(s: TTSState) {
    this.state = s
    this.options.onStateChange?.(s)
  }
}
