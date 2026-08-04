import { detectClearTranslationSourceLanguage } from './translation-language'

describe('detectClearTranslationSourceLanguage', () => {
  it.each([
    ['Bitcoin rallied today', 'en'],
    ['ビットコインが上昇した', 'ja'],
    ['取引の戦略', 'ja'],
    ['비트코인이 상승했다', 'ko'],
    ['比特币今天上涨', null],
    ['仮想通貨市場', null],
    ['Trading 거래', null],
    ['Trading の戦略', null],
    ['한국 market update', null],
    ['交易 AI', null],
    ['🚀 12345 $', null],
  ])('classifies %s as %s', (text, expected) => {
    expect(detectClearTranslationSourceLanguage(text)).toBe(expected)
  })
})
