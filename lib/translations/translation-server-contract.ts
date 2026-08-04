import { z } from 'zod'
import {
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_BATCH_TEXT_LENGTH,
  TRANSLATION_MAX_TEXT_LENGTH,
} from './translation-limits'

export {
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_BATCH_TEXT_LENGTH,
  TRANSLATION_MAX_TEXT_LENGTH,
} from './translation-limits'

export const TRANSLATION_SERVER_REQUEST_TIMEOUT_MS = 40_000
export const TRANSLATION_GOOGLE_TIMEOUT_MS = 5_000
export const TRANSLATION_GPT_TIMEOUT_MS = 30_000
export const TRANSLATION_MAX_REQUEST_BYTES = 1024 * 1024
export const TRANSLATION_MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024
export const TRANSLATION_GPT_CHUNK_CHARACTERS = 2_000
export const TRANSLATION_GPT_CHUNK_MAX_OUTPUT_TOKENS = 4_096

export const TranslationTargetLanguageSchema = z.enum(['zh', 'en', 'ja', 'ko'])
export const TranslationContentTypeSchema = z.enum([
  'post_title',
  'post_content',
  'comment',
  'flash_news',
])

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const RESERVED_IDENTIFIER_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString'])
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

const TranslationTextSchema = z
  .string()
  .min(1)
  .max(TRANSLATION_MAX_TEXT_LENGTH)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !CONTROL_RE.test(value))

const TranslationIdentifierSchema = z
  .string()
  .regex(IDENTIFIER_RE)
  .refine((value) => !RESERVED_IDENTIFIER_KEYS.has(value))

export const SingleTranslationServerRequestSchema = z
  .object({
    text: TranslationTextSchema,
    targetLang: TranslationTargetLanguageSchema,
    contentType: TranslationContentTypeSchema,
    contentId: TranslationIdentifierSchema,
  })
  .strict()

export const BatchTranslationServerItemSchema = z
  .object({
    id: TranslationIdentifierSchema,
    text: TranslationTextSchema,
    contentType: TranslationContentTypeSchema,
    contentId: TranslationIdentifierSchema,
  })
  .strict()

export const BatchTranslationServerRequestSchema = z
  .object({
    items: z.array(BatchTranslationServerItemSchema).min(1).max(TRANSLATION_MAX_BATCH_ITEMS),
    targetLang: TranslationTargetLanguageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>()
    const contentIdentities = new Set<string>()

    if (
      value.items.reduce((total, item) => total + item.text.length, 0) >
      TRANSLATION_MAX_BATCH_TEXT_LENGTH
    ) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Batch source text is too large',
      })
    }

    value.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'id'],
          message: 'Batch item IDs must be unique',
        })
      }
      ids.add(item.id)

      const contentIdentity = JSON.stringify([item.contentType, item.contentId])
      if (contentIdentities.has(contentIdentity)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'contentId'],
          message: 'Batch content identities must be unique',
        })
      }
      contentIdentities.add(contentIdentity)
    })
  })

export const TranslationServerRequestSchema = z.union([
  SingleTranslationServerRequestSchema,
  BatchTranslationServerRequestSchema,
])

export type TranslationTargetLanguage = z.infer<typeof TranslationTargetLanguageSchema>
export type TranslationContentType = z.infer<typeof TranslationContentTypeSchema>
export type SingleTranslationServerRequest = z.infer<typeof SingleTranslationServerRequestSchema>
export type BatchTranslationServerItem = z.infer<typeof BatchTranslationServerItemSchema>
export type BatchTranslationServerRequest = z.infer<typeof BatchTranslationServerRequestSchema>
export type TranslationSourceLanguage = TranslationTargetLanguage | 'unknown'

export type BoundedTranslationJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'aborted' | 'invalid' | 'too_large' }

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/** Bound awaits even when a dependency or test double ignores AbortSignal. */
export function awaitWithAbortSignal<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function declaredBodyLength(headers: Headers): number | null | 'invalid' {
  const raw = headers.get('content-length')
  if (raw === null) return null
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return 'invalid'
  const length = Number(raw)
  return Number.isSafeInteger(length) ? length : 'invalid'
}

type JsonBodySource = Pick<Request, 'body' | 'headers' | 'text'>

/** Read any Fetch body through a physical byte cap and caller-owned deadline. */
export async function readBoundedJsonBody(
  source: JsonBodySource,
  signal: AbortSignal,
  maxBytes: number
): Promise<BoundedTranslationJsonResult> {
  const declaredLength = declaredBodyLength(source.headers)
  if (declaredLength === 'invalid') return { ok: false, reason: 'invalid' }
  if (declaredLength !== null && declaredLength > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }

  if (source.body && typeof source.body.getReader === 'function') {
    const reader = source.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytesRead = 0
    let text = ''

    try {
      while (true) {
        const chunk = await awaitWithAbortSignal(reader.read(), signal)
        if (chunk.done) break
        bytesRead += chunk.value.byteLength
        if (bytesRead > maxBytes) {
          void reader.cancel().catch(() => undefined)
          return { ok: false, reason: 'too_large' }
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
      return { ok: true, value: JSON.parse(text) }
    } catch {
      void reader.cancel().catch(() => undefined)
      return { ok: false, reason: signal.aborted ? 'aborted' : 'invalid' }
    }
  }

  try {
    const text = await awaitWithAbortSignal(source.text(), signal)
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return { ok: false, reason: 'too_large' }
    }
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: signal.aborted ? 'aborted' : 'invalid' }
  }
}

/** Read a translation request through its fixed physical byte cap. */
export function readBoundedTranslationJson(
  request: Request,
  signal: AbortSignal
): Promise<BoundedTranslationJsonResult> {
  return readBoundedJsonBody(request, signal, TRANSLATION_MAX_REQUEST_BYTES)
}

export type TranslationTextChunk = { text: string; suffix: string }

function lastChunkBoundary(
  window: string,
  minimumIndex: number,
  pattern: RegExp
): { index: number; suffix: string } | null {
  let selected: { index: number; suffix: string } | null = null
  for (const match of window.matchAll(pattern)) {
    const index = match.index
    if (index >= minimumIndex && index > 0) {
      selected = { index, suffix: match[0] }
    }
  }
  return selected
}

/**
 * Split a long provider fallback without dropping or inventing source bytes.
 * Natural separators are kept outside the model call and reattached verbatim;
 * an unbroken token falls back to a surrogate-safe hard boundary.
 */
export function splitTranslationText(
  text: string,
  maxCharacters = TRANSLATION_GPT_CHUNK_CHARACTERS
): TranslationTextChunk[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new RangeError('Translation chunk size must be a safe integer of at least 32')
  }

  const chunks: TranslationTextChunk[] = []
  let remaining = text
  while (remaining.length > maxCharacters) {
    let hardEnd = maxCharacters
    const previous = remaining.charCodeAt(hardEnd - 1)
    const next = remaining.charCodeAt(hardEnd)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      hardEnd -= 1
    }

    const window = remaining.slice(0, hardEnd)
    const minimumIndex = Math.floor(hardEnd / 2)
    const boundary =
      lastChunkBoundary(window, minimumIndex, /\s+/gu) ??
      lastChunkBoundary(window, minimumIndex, /[.!?。！？；;]+/gu)

    if (boundary) {
      chunks.push({ text: remaining.slice(0, boundary.index), suffix: boundary.suffix })
      remaining = remaining.slice(boundary.index + boundary.suffix.length)
    } else {
      chunks.push({ text: remaining.slice(0, hardEnd), suffix: '' })
      remaining = remaining.slice(hardEnd)
    }
  }
  if (remaining) {
    const trailingWhitespace = remaining.match(/\s+$/u)?.[0] ?? ''
    const body = remaining.slice(0, remaining.length - trailingWhitespace.length)
    if (body) {
      chunks.push({ text: body, suffix: trailingWhitespace })
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1].suffix += trailingWhitespace
    } else {
      chunks.push({ text: remaining, suffix: '' })
    }
  }
  return chunks
}

const HAN_RE = /\p{Script=Han}/u
const HIRAGANA_RE = /\p{Script=Hiragana}/u
const KATAKANA_RE = /\p{Script=Katakana}/u
const HANGUL_RE = /\p{Script=Hangul}/u
const LATIN_RE = /\p{Script=Latin}/u

/** Detect the four supported source languages without treating emoji/numbers as English. */
export function detectTranslationSourceLanguage(text: string): TranslationSourceLanguage {
  let han = 0
  let kana = 0
  let hangul = 0
  let latin = 0

  for (const character of text) {
    if (HIRAGANA_RE.test(character) || KATAKANA_RE.test(character)) kana += 1
    else if (HANGUL_RE.test(character)) hangul += 1
    else if (HAN_RE.test(character)) han += 1
    else if (LATIN_RE.test(character)) latin += 1
  }

  // Han characters are shared by Chinese and Japanese. Without Kana there is
  // no truthful local distinction (for example, `仮想通貨市場` is Japanese), so
  // keep Han-only or Han-dominant text ambiguous and let the provider's auto
  // detection decide. This deliberately favors a network lookup over a false
  // same-language receipt.
  const candidates: Array<[TranslationTargetLanguage, number]> = [
    ['ja', kana > 0 ? kana + han : 0],
    ['ko', hangul],
    ['en', latin],
  ]
  candidates.sort((left, right) => right[1] - left[1])

  const [leader, runnerUp] = candidates
  const recognized = han + kana + hangul + latin
  return leader[1] > runnerUp[1] && leader[1] / recognized > 0.6 ? leader[0] : 'unknown'
}

export function isUsableTranslationText(value: unknown, sourceText: string): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= TRANSLATION_MAX_TEXT_LENGTH * 4 &&
    value.trim() !== sourceText.trim()
  )
}
