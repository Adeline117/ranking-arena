import enCore from '../en-core'
import zhCore from '../zh-core'
import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

describe('homepage trust copy', () => {
  const subtitles = [
    enCore.heroSubtitle,
    zhCore.heroSubtitle,
    en.heroSubtitle,
    zh.heroSubtitle,
    ja.heroSubtitle,
    ko.heroSubtitle,
  ]

  it('describes the two-hour recompute cadence without claiming real-time rankings', () => {
    for (const subtitle of subtitles) {
      expect(subtitle).toContain('{boards}')
      expect(subtitle).toContain('2')
      expect(subtitle).toMatch(/board|来源板|ソースボード|소스 보드/i)
      expect(subtitle).not.toMatch(/real[- ]?time|实时|リアルタイム|실시간/i)
    }
  })

  it('keeps core and full dictionaries aligned', () => {
    expect(enCore.heroSubtitle).toBe(en.heroSubtitle)
    expect(zhCore.heroSubtitle).toBe(zh.heroSubtitle)
  })
})
