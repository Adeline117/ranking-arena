/** @jest-environment node */

import {
  BatchTranslationServerRequestSchema,
  SingleTranslationServerRequestSchema,
  TRANSLATION_GOOGLE_TIMEOUT_MS,
  TRANSLATION_GPT_TIMEOUT_MS,
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_BATCH_TEXT_LENGTH,
  TRANSLATION_MAX_REQUEST_BYTES,
  TRANSLATION_MAX_TEXT_LENGTH,
  TRANSLATION_SERVER_REQUEST_TIMEOUT_MS,
  TranslationServerRequestSchema,
  detectTranslationSourceLanguage,
  readBoundedTranslationJson,
  splitTranslationText,
} from './translation-server-contract'

const single = {
  text: '交易策略',
  targetLang: 'en',
  contentType: 'post_content',
  contentId: 'post-1',
}

function item(index: number, text = `内容 ${index}`) {
  return {
    id: `item-${index}`,
    text,
    contentType: 'post_content',
    contentId: `post-${index}`,
  }
}

describe('translation server request contract', () => {
  it('leaves bounded request headroom after one parallel provider fallback wave', () => {
    expect(TRANSLATION_SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      TRANSLATION_GOOGLE_TIMEOUT_MS + TRANSLATION_GPT_TIMEOUT_MS
    )
  })

  it('accepts only exact complete single requests, including flash news', () => {
    expect(SingleTranslationServerRequestSchema.safeParse(single).success).toBe(true)
    expect(
      SingleTranslationServerRequestSchema.safeParse({
        ...single,
        contentType: 'flash_news',
      }).success
    ).toBe(true)

    for (const invalid of [
      { ...single, targetLang: 'fr' },
      { ...single, contentType: 'profile' },
      { ...single, contentId: '' },
      { ...single, contentId: '__proto__' },
      { ...single, contentId: 'constructor' },
      { ...single, contentId: undefined },
      { ...single, text: '   ' },
      { ...single, text: `x${'a'.repeat(TRANSLATION_MAX_TEXT_LENGTH)}` },
      { ...single, invented: true },
    ]) {
      expect(SingleTranslationServerRequestSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('requires 1..20 exact items without truncation', () => {
    expect(
      BatchTranslationServerRequestSchema.safeParse({ items: [item(1)], targetLang: 'ja' }).success
    ).toBe(true)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: Array.from({ length: TRANSLATION_MAX_BATCH_ITEMS }, (_value, index) => item(index)),
        targetLang: 'ko',
      }).success
    ).toBe(true)

    expect(
      BatchTranslationServerRequestSchema.safeParse({ items: [], targetLang: 'en' }).success
    ).toBe(false)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: Array.from({ length: TRANSLATION_MAX_BATCH_ITEMS + 1 }, (_value, index) =>
          item(index)
        ),
        targetLang: 'en',
      }).success
    ).toBe(false)
  })

  it('accepts the full post edit contract while bounding aggregate batch work', () => {
    expect(
      SingleTranslationServerRequestSchema.safeParse({
        ...single,
        text: '字'.repeat(TRANSLATION_MAX_TEXT_LENGTH),
      }).success
    ).toBe(true)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: Array.from({ length: 4 }, (_value, index) =>
          item(index, '字'.repeat(TRANSLATION_MAX_TEXT_LENGTH))
        ),
        targetLang: 'en',
      }).success
    ).toBe(true)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: Array.from({ length: 5 }, (_value, index) =>
          item(index, '字'.repeat(TRANSLATION_MAX_TEXT_LENGTH))
        ),
        targetLang: 'en',
      }).success
    ).toBe(false)
    expect(TRANSLATION_MAX_BATCH_TEXT_LENGTH).toBe(4 * TRANSLATION_MAX_TEXT_LENGTH)
  })

  it('rejects duplicate response IDs and duplicate content identities', () => {
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: [item(1), { ...item(2), id: 'item-1' }],
        targetLang: 'en',
      }).success
    ).toBe(false)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: [item(1), { ...item(2), contentId: 'post-1' }],
        targetLang: 'en',
      }).success
    ).toBe(false)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: [item(1), { ...item(2), contentType: 'post_title', contentId: 'post-1' }],
        targetLang: 'en',
      }).success
    ).toBe(true)
  })

  it('does not admit hybrid or extra-key request shapes', () => {
    expect(
      TranslationServerRequestSchema.safeParse({
        ...single,
        items: [item(1)],
      }).success
    ).toBe(false)
    expect(
      BatchTranslationServerRequestSchema.safeParse({
        items: [{ ...item(1), invented: true }],
        targetLang: 'en',
      }).success
    ).toBe(false)
  })

  it.each([
    ['比特币今天上涨', 'unknown'],
    ['仮想通貨市場', 'unknown'],
    ['Bitcoin rallied today', 'en'],
    ['ビットコインが上昇した', 'ja'],
    ['비트코인이 상승했다', 'ko'],
    ['比特币BTC', 'unknown'],
    ['한글AB', 'unknown'],
    ['🚀 12345 $', 'unknown'],
  ])('detects %s as %s', (text, expected) => {
    expect(detectTranslationSourceLanguage(text)).toBe(expected)
  })

  it('splits long fallback text without losing separators, trailing whitespace, or surrogates', () => {
    const source = `${'甲'.repeat(40)}。 ${'🚀'.repeat(24)}  `
    const chunks = splitTranslationText(source, 48)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => `${chunk.text}${chunk.suffix}`).join('')).toBe(source)
    expect(chunks.every((chunk) => !/[\ud800-\udbff]$/u.test(chunk.text))).toBe(true)
    expect(chunks.at(-1)?.suffix.endsWith('  ')).toBe(true)
  })

  it('enforces the physical request byte cap without trusting Content-Length', async () => {
    const oversized = new Request('https://arena.test/api/translate', {
      method: 'POST',
      body: `"${'x'.repeat(TRANSLATION_MAX_REQUEST_BYTES)}"`,
    })
    await expect(
      readBoundedTranslationJson(oversized, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'too_large' })

    const declaredOversized = new Request('https://arena.test/api/translate', {
      method: 'POST',
      headers: { 'content-length': String(TRANSLATION_MAX_REQUEST_BYTES + 1) },
      body: '{}',
    })
    await expect(
      readBoundedTranslationJson(declaredOversized, new AbortController().signal)
    ).resolves.toEqual({ ok: false, reason: 'too_large' })
  })

  it('fits a full 20-item four-byte client batch inside the physical request cap', () => {
    const body = JSON.stringify({
      items: Array.from({ length: TRANSLATION_MAX_BATCH_ITEMS }, (_value, index) =>
        item(
          index,
          '🚀'.repeat(TRANSLATION_MAX_BATCH_TEXT_LENGTH / 2 / TRANSLATION_MAX_BATCH_ITEMS)
        )
      ),
      targetLang: 'en',
    })

    expect(
      JSON.parse(body).items.reduce(
        (total: number, value: { text: string }) => total + value.text.length,
        0
      )
    ).toBe(TRANSLATION_MAX_BATCH_TEXT_LENGTH)
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(TRANSLATION_MAX_REQUEST_BYTES)
    expect(BatchTranslationServerRequestSchema.safeParse(JSON.parse(body)).success).toBe(true)
  })

  it('stops a body reader that is cancelled by the request signal', async () => {
    const controller = new AbortController()
    const request = new Request('https://arena.test/api/translate', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined)
        },
      }),
      duplex: 'half',
    } as RequestInit)

    const result = readBoundedTranslationJson(request, controller.signal)
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(result).resolves.toEqual({ ok: false, reason: 'aborted' })
  })
})
