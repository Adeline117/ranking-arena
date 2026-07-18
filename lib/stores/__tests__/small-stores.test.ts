/**
 * comparisonStore / quizStore / inboxStore / periodStore — 轻量状态机。
 */
import {
  migrateComparisonPersistedState,
  useComparisonStore,
  type CompareTrader,
} from '../comparisonStore'
import { useQuizStore } from '../quizStore'
import { useInboxStore, selectTotalUnread } from '../inboxStore'
import { usePeriodStore } from '../periodStore'

const trader = (id: string, source = 'bybit'): CompareTrader => ({
  id,
  handle: `h-${id}`,
  source,
})

describe('comparisonStore — 对比选择(上限 10)', () => {
  beforeEach(() => useComparisonStore.getState().clearAll())

  it('addTrader 成功 → true;同一复合身份重复 → false', () => {
    expect(useComparisonStore.getState().addTrader(trader('a'))).toBe(true)
    expect(useComparisonStore.getState().addTrader(trader('a'))).toBe(false)
    expect(useComparisonStore.getState().selectedTraders).toHaveLength(1)
  })

  it('允许不同来源使用同一 trader ID', () => {
    expect(useComparisonStore.getState().addTrader(trader('shared', 'bybit'))).toBe(true)
    expect(useComparisonStore.getState().addTrader(trader('shared', 'binance_futures'))).toBe(true)
    expect(useComparisonStore.getState().selectedTraders).toHaveLength(2)
  })

  it('满 10 个 → 拒绝并返回 false', () => {
    for (let i = 0; i < 10; i++) useComparisonStore.getState().addTrader(trader(`t${i}`))
    expect(useComparisonStore.getState().canAddMore()).toBe(false)
    expect(useComparisonStore.getState().addTrader(trader('overflow'))).toBe(false)
    expect(useComparisonStore.getState().selectedTraders).toHaveLength(10)
  })

  it('removeTrader / isSelected', () => {
    const bybit = trader('same', 'bybit')
    const binance = trader('same', 'binance_futures')
    useComparisonStore.getState().addTrader(bybit)
    useComparisonStore.getState().addTrader(binance)

    expect(useComparisonStore.getState().isSelected(bybit)).toBe(true)
    expect(useComparisonStore.getState().isSelected(binance)).toBe(true)
    useComparisonStore.getState().removeTrader(bybit)
    expect(useComparisonStore.getState().isSelected(bybit)).toBe(false)
    expect(useComparisonStore.getState().isSelected(binance)).toBe(true)
  })

  it('getCompareUrl: ids 与 platforms 成对 URI 编码', () => {
    useComparisonStore.getState().addTrader(trader('a b')) // 含空格的 id
    useComparisonStore.getState().addTrader(trader('c', 'binance_futures'))
    expect(useComparisonStore.getState().getCompareUrl()).toBe(
      '/compare?ids=a%20b%2Cc&platforms=bybit%2Cbinance_futures'
    )
  })

  it('v1 持久化数据按复合身份迁移并丢弃无来源条目', () => {
    expect(
      migrateComparisonPersistedState({
        selectedTraders: [
          trader('same', 'bybit'),
          trader('same', 'binance_futures'),
          trader('same', 'bybit'),
          { id: 'legacy', handle: 'Legacy', source: '' },
        ],
        isBarExpanded: false,
      })
    ).toEqual({
      selectedTraders: [trader('same', 'bybit'), trader('same', 'binance_futures')],
      isBarExpanded: false,
    })
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
