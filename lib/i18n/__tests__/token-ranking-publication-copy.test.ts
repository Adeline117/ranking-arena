import en from '../en'
import ja from '../ja'
import ko from '../ko'
import zh from '../zh'

const keys = [
  'tokenRankingUnpublishedTitle',
  'tokenRankingUnpublishedDescription',
  'tokenRankingEmptyCohortTitle',
  'tokenRankingEmptyCohortDescription',
] as const

describe('token ranking publication copy', () => {
  const dictionaries = { en, zh, ja, ko }

  it.each(Object.entries(dictionaries))(
    'defines every publication state in %s',
    (_locale, copy) => {
      for (const key of keys) expect(copy[key].trim()).not.toBe('')
    }
  )

  it.each([
    ['en', en, ['snapshot', 'verifying', 'does not mean there is no trading data']],
    ['zh', zh, ['快照', '验证', '不代表没有交易数据']],
    ['ja', ja, ['スナップショット', '検証', '取引データが存在しないという意味ではありません']],
    ['ko', ko, ['스냅샷', '검증', '거래 데이터가 없다는 뜻은 아닙니다']],
  ])(
    '%s explains that unpublished means the authority snapshot is being verified',
    (_locale, copy, evidence) => {
      for (const phrase of evidence)
        expect(copy.tokenRankingUnpublishedDescription).toContain(phrase)
    }
  )

  it.each([
    ['en', en, ['history', 'price', 'cost basis', 'FX', 'partial/unknown', 'excluded']],
    ['zh', zh, ['历史', '价格', '成本基础', '汇率', '部分/未知', '排除']],
    ['ja', ja, ['取引履歴', '価格', '取得原価', 'FX', '一部／不明', '除外']],
    ['ko', ko, ['거래 내역', '가격', '취득 원가', 'FX', '일부/알 수 없음', '제외']],
  ])(
    '%s discloses every evidence gate and rank exclusion for an empty cohort',
    (_locale, copy, evidence) => {
      for (const phrase of evidence)
        expect(copy.tokenRankingEmptyCohortDescription).toContain(phrase)
    }
  )
})
