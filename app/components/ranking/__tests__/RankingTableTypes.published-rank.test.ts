import {
  selectPublishedRankTraders,
  selectTopPublishedRankTraders,
  type Trader,
} from '../RankingTableTypes'

function trader(id: string, rank: unknown): Trader {
  return {
    id,
    handle: id,
    roi: 1,
    followers: 0,
    rank,
  } as Trader
}

describe('published ranking UI authority', () => {
  it('keeps only positive safe-integer persisted ranks', () => {
    const rows = [
      trader('ranked', 37),
      trader('missing', undefined),
      trader('null', null),
      trader('zero', 0),
      trader('negative', -1),
      trader('fractional', 1.5),
      trader('nan', Number.NaN),
      trader('infinite', Number.POSITIVE_INFINITY),
      trader('numeric-string', '2'),
    ]

    expect(selectPublishedRankTraders(rows)).toEqual([
      expect.objectContaining({ id: 'ranked', rank: 37 }),
    ])
  })

  it('preserves persisted rank instead of renumbering filtered positions', () => {
    const rows = [trader('third', 103), trader('first', 7), trader('unranked', null)]

    expect(selectPublishedRankTraders(rows).map(({ id, rank }) => [id, rank])).toEqual([
      ['third', 103],
      ['first', 7],
    ])
  })

  it('selects hero traders by authoritative rank with no array-index fallback', () => {
    const rows = [
      trader('rank-three', 3),
      trader('unranked-first-slot', null),
      trader('rank-one', 1),
      trader('rank-four', 4),
      trader('rank-two', 2),
    ]

    expect(selectTopPublishedRankTraders(rows).map(({ id, rank }) => [id, rank])).toEqual([
      ['rank-one', 1],
      ['rank-two', 2],
      ['rank-three', 3],
    ])
    expect(selectTopPublishedRankTraders(rows, 0)).toEqual([])
  })
})
