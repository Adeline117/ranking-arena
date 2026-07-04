/**
 * comparisonStore / quizStore / inboxStore / periodStore — 轻量状态机。
 */
import { useComparisonStore, type CompareTrader } from '../comparisonStore'
import { useQuizStore } from '../quizStore'
import { useInboxStore, selectTotalUnread } from '../inboxStore'
import { usePeriodStore } from '../periodStore'

const trader = (id: string): CompareTrader => ({ id, handle: `h-${id}`, source: 'bybit' })

describe('comparisonStore — 对比选择(上限 10)', () => {
  beforeEach(() => useComparisonStore.getState().clearAll())

  it('addTrader 成功 → true;重复 → false', () => {
    expect(useComparisonStore.getState().addTrader(trader('a'))).toBe(true)
    expect(useComparisonStore.getState().addTrader(trader('a'))).toBe(false)
    expect(useComparisonStore.getState().selectedTraders).toHaveLength(1)
  })

  it('满 10 个 → 拒绝并返回 false', () => {
    for (let i = 0; i < 10; i++) useComparisonStore.getState().addTrader(trader(`t${i}`))
    expect(useComparisonStore.getState().canAddMore()).toBe(false)
    expect(useComparisonStore.getState().addTrader(trader('overflow'))).toBe(false)
    expect(useComparisonStore.getState().selectedTraders).toHaveLength(10)
  })

  it('removeTrader / isSelected', () => {
    useComparisonStore.getState().addTrader(trader('a'))
    expect(useComparisonStore.getState().isSelected('a')).toBe(true)
    useComparisonStore.getState().removeTrader('a')
    expect(useComparisonStore.getState().isSelected('a')).toBe(false)
  })

  it('getCompareUrl:逗号列表 URI 编码', () => {
    useComparisonStore.getState().addTrader(trader('a b')) // 含空格的 id
    useComparisonStore.getState().addTrader(trader('c'))
    expect(useComparisonStore.getState().getCompareUrl()).toBe('/compare?ids=a%20b%2Cc')
  })

  it('toggleBar / setBarExpanded', () => {
    useComparisonStore.getState().setBarExpanded(true)
    useComparisonStore.getState().toggleBar()
    expect(useComparisonStore.getState().isBarExpanded).toBe(false)
  })
})

describe('quizStore — 测验进度', () => {
  beforeEach(() => useQuizStore.getState().reset())

  it('setAnswer 合并不覆盖其他题', () => {
    useQuizStore.getState().setAnswer(1, 'a')
    useQuizStore.getState().setAnswer(2, 'b')
    useQuizStore.getState().setAnswer(1, 'c') // 改答案
    expect(useQuizStore.getState().answers).toEqual({ 1: 'c', 2: 'b' })
  })

  it('goToQuestion / reset', () => {
    useQuizStore.getState().goToQuestion(5)
    expect(useQuizStore.getState().currentQuestion).toBe(5)
    useQuizStore.getState().reset()
    expect(useQuizStore.getState()).toMatchObject({ currentQuestion: 0, answers: {}, result: null })
  })
})

describe('inboxStore — 未读计数 + 面板', () => {
  it('selectTotalUnread = 通知 + 私信', () => {
    useInboxStore.getState().setUnreadNotifications(3)
    useInboxStore.getState().setUnreadMessages(2)
    expect(selectTotalUnread(useInboxStore.getState())).toBe(5)
  })

  it('togglePanel / openPanel / closePanel', () => {
    useInboxStore.getState().closePanel()
    useInboxStore.getState().togglePanel()
    expect(useInboxStore.getState().panelOpen).toBe(true)
    useInboxStore.getState().closePanel()
    expect(useInboxStore.getState().panelOpen).toBe(false)
    useInboxStore.getState().openPanel()
    expect(useInboxStore.getState().panelOpen).toBe(true)
  })
})

describe('periodStore — 详情页时间窗', () => {
  it('默认 90D,setPeriod 切换', () => {
    expect(usePeriodStore.getState().period).toBe('90D')
    usePeriodStore.getState().setPeriod('7D')
    expect(usePeriodStore.getState().period).toBe('7D')
    usePeriodStore.getState().setPeriod('90D')
  })
})
