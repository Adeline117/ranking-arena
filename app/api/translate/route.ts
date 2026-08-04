/**
 * Authenticated translation API with exact request validation and hash-bound
 * database caching. Every successful batch is complete; partial work is never
 * represented as success.
 */

import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getSupabaseAdmin, requireAuth } from '@/lib/api'
import {
  TRANSLATION_GOOGLE_TIMEOUT_MS,
  TRANSLATION_GPT_CHUNK_CHARACTERS,
  TRANSLATION_GPT_CHUNK_MAX_OUTPUT_TOKENS,
  TRANSLATION_GPT_TIMEOUT_MS,
  TRANSLATION_MAX_PROVIDER_RESPONSE_BYTES,
  TRANSLATION_SERVER_REQUEST_TIMEOUT_MS,
  TranslationContentTypeSchema,
  TranslationServerRequestSchema,
  TranslationTargetLanguageSchema,
  awaitWithAbortSignal,
  detectTranslationSourceLanguage,
  isUsableTranslationText,
  readBoundedJsonBody,
  readBoundedTranslationJson,
  splitTranslationText,
  type BatchTranslationServerItem,
  type BatchTranslationServerRequest,
  type SingleTranslationServerRequest,
  type TranslationContentType,
  type TranslationSourceLanguage,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-server-contract'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'

const logger = createLogger('translate')

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const TRANSLATION_REQUEST_RATE_LIMIT = {
  requests: 60,
  window: 60,
  prefix: 'translation-request',
  failClose: true,
} as const
const TRANSLATION_ITEM_RATE_LIMIT = {
  requests: 120,
  window: 60,
  prefix: 'translation-item',
  failClose: true,
} as const
const TRANSLATION_GPT_RATE_LIMIT = {
  requests: 120,
  window: 60,
  prefix: 'translation-gpt',
  failClose: true,
} as const

const GOOGLE_TARGET_CODE: Record<TranslationTargetLanguage, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
}

const GOOGLE_SOURCE_CODE: Record<TranslationSourceLanguage, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  unknown: 'auto',
}

const GPT_TARGET_LANGUAGE: Record<TranslationTargetLanguage, string> = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>

type TranslationResult = {
  translatedText: string
  cached: boolean
}

type ProviderTranslationResult = {
  translatedText: string
  sameLanguage: boolean
}

type TranslationCacheRow = {
  content_type: TranslationContentType
  content_id: string
  content_hash: string
  source_lang: TranslationSourceLanguage
  target_lang: TranslationTargetLanguage
  translated_text: string
}

class TranslationDependencyError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503
  ) {
    super(message)
    this.name = 'TranslationDependencyError'
  }
}

class TranslationRateLimitError extends Error {
  constructor(readonly response: Response) {
    super('Translation rate limit rejected the request')
    this.name = 'TranslationRateLimitError'
  }
}

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('CDN-Cache-Control', 'no-store')
  headers.set('Vercel-CDN-Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')

  const vary = new Set(
    (headers.get('Vary') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  vary.add('Authorization')
  vary.add('Cookie')
  headers.set('Vary', [...vary].join(', '))

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
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

function isTranslationCacheRow(value: unknown): value is TranslationCacheRow {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'content_hash',
      'content_id',
      'content_type',
      'source_lang',
      'target_lang',
      'translated_text',
    ]) &&
    TranslationContentTypeSchema.safeParse(value.content_type).success &&
    typeof value.content_id === 'string' &&
    typeof value.content_hash === 'string' &&
    (value.source_lang === 'unknown' ||
      TranslationTargetLanguageSchema.safeParse(value.source_lang).success) &&
    TranslationTargetLanguageSchema.safeParse(value.target_lang).success &&
    typeof value.translated_text === 'string'
  )
}

function requestSignal(request: Request): AbortSignal {
  return AbortSignal.any([
    request.signal,
    AbortSignal.timeout(TRANSLATION_SERVER_REQUEST_TIMEOUT_MS),
  ])
}

function childSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
}

function hasDistributedTranslationLimiter(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  )
}

async function consumeTranslationBudget(
  request: NextRequest,
  actorId: string,
  config:
    | typeof TRANSLATION_REQUEST_RATE_LIMIT
    | typeof TRANSLATION_ITEM_RATE_LIMIT
    | typeof TRANSLATION_GPT_RATE_LIMIT,
  units: number,
  signal: AbortSignal
): Promise<void> {
  let response: Response | null
  try {
    response = await awaitWithAbortSignal(checkRateLimit(request, config, actorId, units), signal)
  } catch (error: unknown) {
    if (signal.aborted) throw error
    logger.error('Translation rate-limit check failed', { error: String(error) })
    throw new TranslationDependencyError('Translation service unavailable', 503)
  }
  if (response) throw new TranslationRateLimitError(response)
}

async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown | null> {
  // Fetch always returns the full Body mixin in production. The fallback keeps
  // deliberately minimal unit-test doubles usable without weakening the real
  // transport boundary.
  if (
    !response.headers ||
    typeof response.headers.get !== 'function' ||
    typeof response.text !== 'function'
  ) {
    return await awaitWithAbortSignal(response.json(), signal)
  }
  const decoded = await readBoundedJsonBody(
    response,
    signal,
    TRANSLATION_MAX_PROVIDER_RESPONSE_BYTES
  )
  return decoded.ok ? decoded.value : null
}

async function translateWithGoogle(
  text: string,
  targetLang: TranslationTargetLanguage,
  sourceLang: TranslationSourceLanguage,
  parentSignal: AbortSignal
): Promise<ProviderTranslationResult | null> {
  const signal = childSignal(parentSignal, TRANSLATION_GOOGLE_TIMEOUT_MS)
  const body = new URLSearchParams({
    client: 'gtx',
    sl: GOOGLE_SOURCE_CODE[sourceLang],
    tl: GOOGLE_TARGET_CODE[targetLang],
    dt: 't',
    q: text,
  })

  try {
    const response = await awaitWithAbortSignal(
      fetch(GOOGLE_TRANSLATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        signal,
      }),
      signal
    )
    if (!response.ok) return null

    const data = await readProviderJson(response, signal)
    if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length === 0) return null
    if (
      !data[0].every(
        (segment: unknown): segment is [string, string, ...unknown[]] =>
          Array.isArray(segment) && typeof segment[0] === 'string' && typeof segment[1] === 'string'
      )
    ) {
      return null
    }

    const translated = data[0].map((segment) => segment[0]).join('')
    const echoedSource = data[0].map((segment) => segment[1]).join('')
    if (echoedSource !== text) return null

    const detectedSource =
      typeof data[2] === 'string' ? data[2].trim().toLowerCase().replace('_', '-') : ''
    const normalizedDetectedSource: TranslationSourceLanguage = detectedSource.startsWith('zh')
      ? 'zh'
      : detectedSource.startsWith('en')
        ? 'en'
        : detectedSource.startsWith('ja')
          ? 'ja'
          : detectedSource.startsWith('ko')
            ? 'ko'
            : 'unknown'

    const isSourceEcho = translated.trim() === text.trim()
    if (isUsableTranslationText(translated, text)) {
      return { translatedText: translated, sameLanguage: false }
    }
    if (isSourceEcho && normalizedDetectedSource === targetLang) {
      return { translatedText: text, sameLanguage: true }
    }
    return null
  } catch (error: unknown) {
    if (parentSignal.aborted) throw error
    logger.warn('Google Translate failed, falling back to GPT', { error: String(error) })
    return null
  }
}

function fixCryptoTerms(text: string, targetLang: TranslationTargetLanguage): string {
  if (targetLang !== 'zh') return text
  return text
    .replace(/合同/g, '合约')
    .replace(/杠杆化/g, '杠杆')
    .replace(/长仓/g, '多仓')
    .replace(/空仓/g, '做空')
    .replace(/投资回报率/g, 'ROI')
    .replace(/最大跌幅/g, '最大回撤')
    .replace(/最大回落/g, '最大回撤')
    .replace(/最大降幅/g, '最大回撤')
    .replace(/胜率百分比/g, '胜率')
    .replace(/交易计数/g, '交易次数')
    .replace(/利润和损失/g, '盈亏')
    .replace(/损益/g, '盈亏')
    .replace(/清算/g, '爆仓')
    .replace(/现货交易/g, '现货')
    .replace(/期货交易/g, '合约')
    .replace(/去中心化交易所/g, 'DEX')
    .replace(/中心化交易所/g, 'CEX')
    .replace(/交易机器人/g, '交易Bot')
    .replace(/复制交易/g, '跟单')
    .replace(/跟随交易/g, '跟单')
}

async function translateGptChunk(
  sourceText: string,
  targetLang: TranslationTargetLanguage,
  apiKey: string,
  parentSignal: AbortSignal
): Promise<string | null> {
  try {
    const response = await awaitWithAbortSignal(
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are an expert translator for a crypto trading community platform. Translate to ${GPT_TARGET_LANGUAGE[targetLang]}.

Domain: cryptocurrency, trading, DeFi, blockchain.

Key terms (EN→ZH): copy trading=跟单, futures=合约, spot=现货, leverage=杠杆, liquidation=爆仓, ROI=ROI, MDD/max drawdown=最大回撤, win rate=胜率, PnL=盈亏, long=做多, short=做空, whale=巨鲸, degen=Degen, alpha=Alpha, CEX=CEX, DEX=DEX, TVL=TVL, APY=APY, staking=质押, yield=收益, airdrop=空投, rug pull=Rug Pull, HODL=HODL, moon=暴涨, dump=暴跌, FUD=FUD, DYOR=DYOR, NFA=NFA.

Rules:
1. Keep original meaning, tone, and slang
2. Keep numbers, punctuation, emoji unchanged
3. Keep crypto tickers ($BTC, $ETH) and addresses unchanged
4. Output translated text only, no explanations`,
            },
            { role: 'user', content: sourceText },
          ],
          temperature: 0.3,
          store: false,
          max_completion_tokens: TRANSLATION_GPT_CHUNK_MAX_OUTPUT_TOKENS,
        }),
        signal: parentSignal,
      }),
      parentSignal
    )
    if (!response.ok) {
      logger.error('OpenAI API error', { status: response.status })
      return null
    }

    const data = await readProviderJson(response, parentSignal)
    if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length !== 1) return null
    const firstChoice = data.choices[0]
    if (
      !isRecord(firstChoice) ||
      firstChoice.finish_reason !== 'stop' ||
      !isRecord(firstChoice.message)
    ) {
      return null
    }
    const translated = firstChoice.message.content
    return typeof translated === 'string' &&
      translated.trim().length > 0 &&
      translated.length <= TRANSLATION_GPT_CHUNK_CHARACTERS * 4
      ? translated.trim()
      : null
  } catch (error: unknown) {
    if (parentSignal.aborted) throw error
    logger.error('OpenAI request failed', { error: String(error) })
    return null
  }
}

async function translateWithGpt(
  text: string,
  targetLang: TranslationTargetLanguage,
  request: NextRequest,
  actorId: string,
  parentSignal: AbortSignal
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.error('OPENAI_API_KEY not configured')
    return null
  }

  const chunks = splitTranslationText(text)
  const deadlineSignal = childSignal(parentSignal, TRANSLATION_GPT_TIMEOUT_MS)
  const chunkController = new AbortController()
  const signal = AbortSignal.any([deadlineSignal, chunkController.signal])

  try {
    await consumeTranslationBudget(
      request,
      actorId,
      TRANSLATION_GPT_RATE_LIMIT,
      chunks.length,
      signal
    )
    const translatedChunks = await Promise.all(
      chunks.map(async (chunk) => {
        const leadingWhitespace = chunk.text.match(/^\s+/u)?.[0] ?? ''
        const trailingWhitespace = chunk.text.match(/\s+$/u)?.[0] ?? ''
        const sourceText = chunk.text.slice(
          leadingWhitespace.length,
          chunk.text.length - trailingWhitespace.length
        )
        if (!sourceText) return `${chunk.text}${chunk.suffix}`

        const translated = await translateGptChunk(sourceText, targetLang, apiKey, signal)
        if (translated === null) {
          if (!chunkController.signal.aborted) {
            chunkController.abort(new DOMException('Translation chunk failed', 'AbortError'))
          }
          throw new TranslationDependencyError('Translation failed', 502)
        }
        return `${leadingWhitespace}${translated}${trailingWhitespace}${chunk.suffix}`
      })
    )
    const translated = translatedChunks.join('')
    return isUsableTranslationText(translated, text) ? translated : null
  } catch (error: unknown) {
    if (!chunkController.signal.aborted) {
      chunkController.abort(new DOMException('Translation chunk failed', 'AbortError'))
    }
    if (parentSignal.aborted) throw error
    if (error instanceof TranslationRateLimitError) throw error
    if (error instanceof TranslationDependencyError && error.status === 503) throw error
    logger.error('OpenAI fallback failed', { error: String(error) })
    return null
  }
}

async function translate(
  text: string,
  targetLang: TranslationTargetLanguage,
  sourceLang: TranslationSourceLanguage,
  request: NextRequest,
  actorId: string,
  signal: AbortSignal
): Promise<ProviderTranslationResult | null> {
  const googleResult = await translateWithGoogle(text, targetLang, sourceLang, signal)
  if (googleResult) {
    return googleResult.sameLanguage
      ? googleResult
      : {
          translatedText: fixCryptoTerms(googleResult.translatedText, targetLang),
          sameLanguage: false,
        }
  }
  const translatedText = await translateWithGpt(text, targetLang, request, actorId, signal)
  return translatedText === null ? null : { translatedText, sameLanguage: false }
}

async function readSingleCache(
  supabase: SupabaseAdmin,
  input: SingleTranslationServerRequest,
  signal: AbortSignal
): Promise<TranslationCacheRow | null> {
  const query = supabase
    .from('translation_cache')
    .select('content_type, content_id, content_hash, source_lang, target_lang, translated_text')
    .eq('content_type', input.contentType)
    .eq('content_id', input.contentId)
    .eq('target_lang', input.targetLang)
    .abortSignal(signal)
    .maybeSingle()
  const { data, error } = await awaitWithAbortSignal(query, signal)

  if (error) {
    logger.error('Translation cache query failed', { code: error.code })
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }
  if (data === null) return null
  if (!isTranslationCacheRow(data)) {
    logger.error('Translation cache returned a malformed single row')
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }
  if (
    data.content_type !== input.contentType ||
    data.content_id !== input.contentId ||
    data.target_lang !== input.targetLang
  ) {
    logger.error('Translation cache returned a mismatched single identity')
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }
  return data
}

async function readBatchCache(
  supabase: SupabaseAdmin,
  contentType: TranslationContentType,
  contentIds: string[],
  targetLang: TranslationTargetLanguage,
  signal: AbortSignal
): Promise<Map<string, TranslationCacheRow>> {
  const query = supabase
    .from('translation_cache')
    .select('content_type, content_id, content_hash, source_lang, target_lang, translated_text')
    .eq('content_type', contentType)
    .in('content_id', contentIds)
    .eq('target_lang', targetLang)
    .abortSignal(signal)
  const { data, error } = await awaitWithAbortSignal(query, signal)

  if (error) {
    logger.error('Batch translation cache query failed', { code: error.code })
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }
  if (!Array.isArray(data) || !data.every(isTranslationCacheRow)) {
    logger.error('Translation cache returned malformed batch rows')
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }

  const expectedIds = new Set(contentIds)
  const rows = new Map<string, TranslationCacheRow>()
  for (const row of data) {
    if (
      row.content_type !== contentType ||
      row.target_lang !== targetLang ||
      !expectedIds.has(row.content_id) ||
      rows.has(row.content_id)
    ) {
      logger.error('Translation cache returned ambiguous batch rows')
      throw new TranslationDependencyError('Translation cache unavailable', 503)
    }
    rows.set(row.content_id, row)
  }
  return rows
}

async function writeTranslationCache(
  supabase: SupabaseAdmin,
  rows: Array<{
    content_type: TranslationContentType
    content_id: string
    content_hash: string
    source_lang: TranslationSourceLanguage
    target_lang: TranslationTargetLanguage
    translated_text: string
    updated_at: string
  }>,
  signal: AbortSignal
): Promise<void> {
  if (rows.length === 0) return
  const query = supabase
    .from('translation_cache')
    .upsert(rows, { onConflict: 'content_type,content_id,target_lang' })
    .abortSignal(signal)
  const { error } = await awaitWithAbortSignal(query, signal)
  if (error) {
    logger.error('Translation cache save failed', { code: error.code })
    throw new TranslationDependencyError('Translation cache unavailable', 503)
  }
}

async function handleSingleTranslate(
  input: SingleTranslationServerRequest,
  supabase: SupabaseAdmin,
  request: NextRequest,
  actorId: string,
  signal: AbortSignal
): Promise<Response> {
  const sourceLang = detectTranslationSourceLanguage(input.text)
  if (sourceLang === input.targetLang) {
    return NextResponse.json({
      success: true,
      data: {
        translatedText: input.text,
        originalText: input.text,
        targetLang: input.targetLang,
        cached: true,
        sameLanguage: true,
      },
    })
  }

  const contentHash = hashContent(input.text)
  const cached = await readSingleCache(supabase, input, signal)
  if (
    cached?.content_hash === contentHash &&
    cached.source_lang === sourceLang &&
    isUsableTranslationText(cached.translated_text, input.text)
  ) {
    return NextResponse.json({
      success: true,
      data: {
        translatedText: cached.translated_text,
        originalText: input.text,
        targetLang: input.targetLang,
        cached: true,
      },
    })
  }

  const translated = await translate(
    input.text,
    input.targetLang,
    sourceLang,
    request,
    actorId,
    signal
  )
  if (!translated) throw new TranslationDependencyError('Translation failed', 502)
  if (translated.sameLanguage) {
    return NextResponse.json({
      success: true,
      data: {
        translatedText: input.text,
        originalText: input.text,
        targetLang: input.targetLang,
        cached: true,
        sameLanguage: true,
      },
    })
  }

  await writeTranslationCache(
    supabase,
    [
      {
        content_type: input.contentType,
        content_id: input.contentId,
        content_hash: contentHash,
        source_lang: sourceLang,
        target_lang: input.targetLang,
        translated_text: translated.translatedText,
        updated_at: new Date().toISOString(),
      },
    ],
    signal
  )

  return NextResponse.json({
    success: true,
    data: {
      translatedText: translated.translatedText,
      originalText: input.text,
      targetLang: input.targetLang,
      cached: false,
    },
  })
}

async function handleBatchTranslate(
  input: BatchTranslationServerRequest,
  supabase: SupabaseAdmin,
  request: NextRequest,
  actorId: string,
  signal: AbortSignal
): Promise<Response> {
  const results = new Map<string, TranslationResult>()
  const pending: Array<{
    item: BatchTranslationServerItem
    sourceLang: TranslationSourceLanguage
    contentHash: string
  }> = []

  for (const item of input.items) {
    const sourceLang = detectTranslationSourceLanguage(item.text)
    if (sourceLang === input.targetLang) {
      results.set(item.id, { translatedText: item.text, cached: true })
    } else {
      pending.push({ item, sourceLang, contentHash: hashContent(item.text) })
    }
  }

  for (const contentType of [...new Set(pending.map(({ item }) => item.contentType))]) {
    const candidates = pending.filter(({ item }) => item.contentType === contentType)
    const cachedRows = await readBatchCache(
      supabase,
      contentType,
      candidates.map(({ item }) => item.contentId),
      input.targetLang,
      signal
    )

    for (const candidate of candidates) {
      const cached = cachedRows.get(candidate.item.contentId)
      if (
        cached?.content_hash === candidate.contentHash &&
        cached.source_lang === candidate.sourceLang &&
        isUsableTranslationText(cached.translated_text, candidate.item.text)
      ) {
        results.set(candidate.item.id, { translatedText: cached.translated_text, cached: true })
      }
    }
  }

  const needsTranslation = pending.filter(({ item }) => !results.has(item.id))
  const translated = new Map<
    string,
    { candidate: (typeof needsTranslation)[number]; translatedText: string }
  >()
  const batchController = new AbortController()
  const batchSignal = AbortSignal.any([signal, batchController.signal])

  try {
    const freshResults = await Promise.all(
      needsTranslation.map(async (candidate) => {
        const result = await translate(
          candidate.item.text,
          input.targetLang,
          candidate.sourceLang,
          request,
          actorId,
          batchSignal
        )
        if (result === null) throw new TranslationDependencyError('Translation failed', 502)
        return { candidate, result }
      })
    )

    for (const { candidate, result } of freshResults) {
      if (result.sameLanguage) {
        results.set(candidate.item.id, {
          translatedText: candidate.item.text,
          cached: true,
        })
      } else {
        translated.set(candidate.item.id, {
          candidate,
          translatedText: result.translatedText,
        })
      }
    }
  } catch (error: unknown) {
    if (!batchController.signal.aborted) {
      batchController.abort(new DOMException('Translation batch failed', 'AbortError'))
    }
    throw error
  }

  await writeTranslationCache(
    supabase,
    [...translated.values()].map(({ candidate, translatedText }) => ({
      content_type: candidate.item.contentType,
      content_id: candidate.item.contentId,
      content_hash: candidate.contentHash,
      source_lang: candidate.sourceLang,
      target_lang: input.targetLang,
      translated_text: translatedText,
      updated_at: new Date().toISOString(),
    })),
    signal
  )

  for (const [id, value] of translated) {
    results.set(id, { translatedText: value.translatedText, cached: false })
  }

  if (results.size !== input.items.length || input.items.some((item) => !results.has(item.id))) {
    logger.error('Translation batch did not produce one result per item')
    throw new TranslationDependencyError('Translation failed', 502)
  }

  const responseResults = Object.fromEntries(results)
  const cachedCount = [...results.values()].filter((result) => result.cached).length
  return NextResponse.json({
    success: true,
    data: {
      results: responseResults,
      total: input.items.length,
      cached: cachedCount,
      translated: input.items.length - cachedCount,
    },
  })
}

async function createTranslationResponse(request: NextRequest): Promise<Response> {
  const signal = requestSignal(request)
  let actorId: string

  try {
    const user = await awaitWithAbortSignal(requireAuth(request), signal)
    actorId = user.id
  } catch {
    if (signal.aborted) {
      logger.warn('Translation request expired during authentication')
      return errorResponse('Translation service unavailable', 503)
    }
    return errorResponse('Authentication required', 401)
  }

  try {
    if (!hasDistributedTranslationLimiter()) {
      logger.error('Distributed translation rate limiter is not configured')
      throw new TranslationDependencyError('Translation service unavailable', 503)
    }
    await consumeTranslationBudget(request, actorId, TRANSLATION_REQUEST_RATE_LIMIT, 1, signal)

    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return errorResponse('Content-Type must be application/json', 415)
    }

    const decoded = await readBoundedTranslationJson(request, signal)
    if (!decoded.ok) {
      if (decoded.reason === 'too_large') return errorResponse('Request body too large', 413)
      if (decoded.reason === 'aborted') {
        return errorResponse('Translation service unavailable', 503)
      }
      return errorResponse('Invalid JSON body', 400)
    }

    const parsed = TranslationServerRequestSchema.safeParse(decoded.value)
    if (!parsed.success) return errorResponse('Invalid translation request', 400)

    await consumeTranslationBudget(
      request,
      actorId,
      TRANSLATION_ITEM_RATE_LIMIT,
      'items' in parsed.data ? parsed.data.items.length : 1,
      signal
    )

    const supabase = getSupabaseAdmin()
    return 'items' in parsed.data
      ? await handleBatchTranslate(parsed.data, supabase, request, actorId, signal)
      : await handleSingleTranslate(parsed.data, supabase, request, actorId, signal)
  } catch (error: unknown) {
    if (signal.aborted) {
      logger.warn('Translation request was cancelled or exceeded its deadline')
      return errorResponse('Translation service unavailable', 503)
    }
    if (error instanceof TranslationDependencyError) {
      return errorResponse(error.message, error.status)
    }
    if (error instanceof TranslationRateLimitError) return error.response
    throw error
  }
}

export async function GET(): Promise<Response> {
  return privateNoStore(errorResponse('Use POST to translate', 405))
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    return privateNoStore(await createTranslationResponse(request))
  } catch (error: unknown) {
    logger.error('Translation service error', { error: String(error) })
    return privateNoStore(errorResponse('Translation service error', 500))
  }
}
