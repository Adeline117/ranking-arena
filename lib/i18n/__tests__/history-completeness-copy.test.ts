import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

const keys = [
  'historyCompletenessPartialTitle',
  'historyCompletenessPartialDescription',
  'historyCompletenessUnknownTitle',
  'historyCompletenessUnknownDescription',
] as const

describe('history completeness disclosure copy', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja],
    ['ko', ko],
  ])('defines every disclosure in %s', (_language, dictionary) => {
    for (const key of keys) expect(dictionary[key]?.trim()).not.toBe('')
  })

  it.each([
    ['en', en, 'not used in rankings'],
    ['zh', zh, '不参与排名'],
    ['ja', ja, 'ランキングには使用されません'],
    ['ko', ko, '순위에 사용되지 않습니다'],
  ])('states rank exclusion in both %s descriptions', (_language, dictionary, exclusion) => {
    expect(dictionary.historyCompletenessPartialDescription).toContain(exclusion)
    expect(dictionary.historyCompletenessUnknownDescription).toContain(exclusion)
  })

  it.each([
    ['en', en, 'More records in Stats → Records'],
    ['zh', zh, '更多记录见 统计 → 交易记录'],
    ['ja', ja, 'その他の記録は 統計 → 取引記録 へ'],
    ['ko', ko, '더 많은 기록은 통계 → 거래 기록에서'],
  ])(
    'does not claim the recent-activity preview is full history in %s',
    (_language, dictionary, copy) => {
      expect(dictionary.recentActivityViewAll).toBe(copy)
    }
  )
})
