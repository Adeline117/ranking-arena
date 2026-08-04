import { apiFetch } from '@/lib/utils/api-fetch'

export const TRANSLATION_REQUEST_TIMEOUT_MS = 15_000

export type TranslationTargetLanguage = 'zh' | 'en'

export type SingleTranslationRequest = {
  text: string
  targetLang: TranslationTargetLanguage
  contentType: 'post_title' | 'post_content' | 'comment'
  contentId: string
}

export type BatchTranslationItem = SingleTranslationRequest & { id: string }

export type SingleTranslationReceipt = {
  translatedText: string
  cached: boolean
  sameLanguage: boolean
}

export type BatchTranslationReceipt = {
  results: Record<string, { translatedText: string; cached: boolean }>
  total: number
  cached: number
  translated: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isTranslationText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Bind a successful single-item response to the exact source text and target
 * language that the caller sent. The API explicitly marks its legitimate
 * same-language identity response; an unmarked source echo fails closed.
 */
export function readSingleTranslationResponse(
  value: unknown,
  expected: Pick<SingleTranslationRequest, 'text' | 'targetLang'>
): SingleTranslationReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, ['data', 'success']) || value.success !== true) {
    return null
  }
  if (!isRecord(value.data)) return null

  const data = value.data
  const keys = Object.prototype.hasOwnProperty.call(data, 'sameLanguage')
    ? ['cached', 'originalText', 'sameLanguage', 'targetLang', 'translatedText']
    : ['cached', 'originalText', 'targetLang', 'translatedText']
  if (
    !hasExactKeys(data, keys) ||
    !isTranslationText(data.translatedText) ||
    data.originalText !== expected.text ||
    data.targetLang !== expected.targetLang ||
    typeof data.cached !== 'boolean'
  ) {
    return null
  }

  const sameLanguage = data.sameLanguage === true
  if (
    (Object.prototype.hasOwnProperty.call(data, 'sameLanguage') && !sameLanguage) ||
    (sameLanguage && data.translatedText !== expected.text) ||
    (!sameLanguage && data.translatedText.trim() === expected.text.trim())
  ) {
    return null
  }

  return {
    translatedText: data.translatedText,
    cached: data.cached,
    sameLanguage,
  }
}

/**
 * The current API has no explicit partial-success partition: it can omit a
 * failed result while still returning success=true. Consequently the only
 * truthful response clients can publish is one whose result keys exactly cover
 * every unique requested item. Any omission or extra item rejects the batch.
 */
export function readBatchTranslationResponse(
  value: unknown,
  expectedItems: readonly BatchTranslationItem[]
): BatchTranslationReceipt | null {
  if (
    expectedItems.length === 0 ||
    expectedItems.length > 20 ||
    expectedItems.some(
      (item) =>
        !item.id ||
        !item.contentId ||
        !isTranslationText(item.text) ||
        (item.targetLang !== 'zh' && item.targetLang !== 'en')
    ) ||
    new Set(expectedItems.map((item) => item.id)).size !== expectedItems.length ||
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'success']) ||
    value.success !== true
  ) {
    return null
  }

  const data = value.data
  if (
    !isRecord(data) ||
    !hasExactKeys(data, ['cached', 'results', 'total', 'translated']) ||
    !isRecord(data.results)
  ) {
    return null
  }
  const responseResults = data.results
  const expectedIds = expectedItems.map((item) => item.id)
  if (
    data.total !== expectedItems.length ||
    !isNonnegativeSafeInteger(data.cached) ||
    !isNonnegativeSafeInteger(data.translated) ||
    data.cached + data.translated !== data.total ||
    !hasExactKeys(responseResults, expectedIds)
  ) {
    return null
  }

  const results: Record<string, { translatedText: string; cached: boolean }> = {}
  for (const id of expectedIds) {
    const result = responseResults[id]
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ['cached', 'translatedText']) ||
      !isTranslationText(result.translatedText) ||
      typeof result.cached !== 'boolean'
    ) {
      return null
    }
    results[id] = { translatedText: result.translatedText, cached: result.cached }
  }

  return {
    results,
    total: data.total,
    cached: data.cached,
    translated: data.translated,
  }
}

type TranslationRequestOptions = {
  accessToken: string
  csrfHeaders?: Record<string, string>
  signal?: AbortSignal
}

function requestHeaders(options: TranslationRequestOptions): Record<string, string> {
  if (!options.accessToken.trim()) throw new Error('Translation request identity is missing')
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.accessToken}`,
    ...options.csrfHeaders,
  }
}

export async function requestSingleTranslation(
  request: SingleTranslationRequest,
  options: TranslationRequestOptions
): Promise<SingleTranslationReceipt> {
  const value = await apiFetch<unknown>('/api/translate', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: requestHeaders(options),
    body: JSON.stringify(request),
    signal: options.signal,
    timeoutMs: TRANSLATION_REQUEST_TIMEOUT_MS,
  })
  const receipt = readSingleTranslationResponse(value, request)
  if (!receipt) throw new Error('Translation API returned an invalid single-item response')
  return receipt
}

export async function requestBatchTranslation(
  items: readonly BatchTranslationItem[],
  targetLang: TranslationTargetLanguage,
  options: TranslationRequestOptions
): Promise<BatchTranslationReceipt> {
  if (items.some((item) => item.targetLang !== targetLang)) {
    throw new Error('Translation batch target language is inconsistent')
  }
  const value = await apiFetch<unknown>('/api/translate', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: requestHeaders(options),
    body: JSON.stringify({
      items: items.map(({ id, text, contentType, contentId }) => ({
        id,
        text,
        contentType,
        contentId,
      })),
      targetLang,
    }),
    signal: options.signal,
    timeoutMs: TRANSLATION_REQUEST_TIMEOUT_MS,
  })
  const receipt = readBatchTranslationResponse(value, items)
  if (!receipt) throw new Error('Translation API returned an invalid batch response')
  return receipt
}
