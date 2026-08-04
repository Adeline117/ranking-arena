import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXCHANGE_BIND_LIST,
  isV1ExchangeBindingSupported,
  v1ExchangeBindingSelection,
} from './exchange-configs'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'

describe('V1 public API-key binding boundary', () => {
  it('advertises only exchanges with authoritative read-only permission proof', () => {
    expect(EXCHANGE_BIND_LIST.map(({ id }) => id)).toEqual(['binance', 'bybit', 'bitget'])
    expect(EXCHANGE_BIND_LIST.map(({ name }) => name)).toEqual(['Binance', 'Bybit', 'Bitget'])
    expect(EXCHANGE_BIND_LIST.every(({ oauthSupported }) => oauthSupported === false)).toBe(true)

    expect(isV1ExchangeBindingSupported('binance')).toBe(true)
    expect(isV1ExchangeBindingSupported('bybit')).toBe(true)
    expect(isV1ExchangeBindingSupported('bitget')).toBe(true)
    expect(isV1ExchangeBindingSupported('okx')).toBe(false)
    expect(isV1ExchangeBindingSupported('mexc')).toBe(false)
    expect(v1ExchangeBindingSelection('binance')).toBe('binance')
    expect(v1ExchangeBindingSelection('okx')).toBeNull()
    expect(v1ExchangeBindingSelection('gmx')).toBeNull()
    expect(v1ExchangeBindingSelection(null)).toBeNull()
  })

  it('posts the selected exchange to the sole live authorization endpoint', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/exchange/auth/api-key/page.tsx'),
      'utf8'
    )

    expect(source).toContain("fetch('/api/trader/authorize'")
    expect(source).toContain('platform: supportedExchange')
    expect(source).toContain('const selectedExchange = v1ExchangeBindingSelection(exchangeParam)')
    expect(source).not.toContain('setSelectedExchange')
    expect(source).toContain('v1ExchangeBindingSelection(selectedExchange)')
    expect(source).not.toContain("fetch('/api/exchange/connect'")
  })

  it('keeps the V1 method chooser free of the retired OAuth flow', () => {
    const source = readFileSync(join(process.cwd(), 'app/(app)/exchange/auth/page.tsx'), 'utf8')

    expect(source).not.toContain('handleOAuth')
    expect(source).not.toContain('requestExchangeOAuthUrl')
    expect(source).not.toContain('readCurrentOAuthAccessToken')
  })

  it('keeps all live locales honest about the private connection scope', () => {
    const liveCopy = [en, zh, ja, ko].map((messages) =>
      [
        messages.bindExchangeAccountFull,
        messages.bindExchangeBannerDesc,
        messages.authBenefitBadge,
        messages.authBenefitPriority,
      ].join(' ')
    )

    expect(liveCopy).toHaveLength(4)
    for (const copy of liveCopy) {
      expect(copy).not.toMatch(
        /automatic|auto-publish|real[- ]?time data|实时数据|自動公開|リアルタイムデータ|자동 게시|실시간 데이터/i
      )
    }
    expect(en.authBenefitBadge).toBe('No verification badge')
    expect(zh.authBenefitBadge).toBe('不授予认证标识')
    expect(ja.authBenefitBadge).toBe('認証バッジの付与なし')
    expect(ko.authBenefitBadge).toBe('인증 배지 없음')
  })
})
