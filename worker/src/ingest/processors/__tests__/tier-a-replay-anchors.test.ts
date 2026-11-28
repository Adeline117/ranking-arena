import type { RawPage } from '@/lib/ingest/core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'

import { replayedIdentityPageRankAnchors } from '../tier-a-leaderboard'

function storedPages(rowCounts: number[]): RawPage[] {
  return rowCounts.map((count, index) => ({
    fetchedAt: `2026-11-27T10:0${index}:00.000Z`,
    pageIndex: index + 1,
    payload: { items: Array.from({ length: count }, (_, row) => ({ id: `p${index + 1}-${row}` })) },
    url: `https://bybit.test/mt5?page=${index + 1}`,
  }))
}

function manifestFor(pages: RawPage[], rowCounts: number[], parserOrdinals: number[]) {
  return {
    source_pages: pages.map((page, index) => ({
      ordinal: index + 1,
      stored_page_index: page.pageIndex,
      url: page.url,
      fetched_at: page.fetchedAt,
      payload: {
        serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
        sha256: strictCanonicalSha256(page.payload),
      },
      source_row_count: rowCounts[index],
      request_sha256: 'a'.repeat(64),
      http_status: 200,
      pagination_position: { kind: 'page_index' as const, request_page_index: index + 1 },
      source_reports: null,
    })),
    parser_input: {
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      sha256: 'b'.repeat(64),
      page_count: parserOrdinals.length,
      transformation: {
        kind: 'identity_projection' as const,
        source_page_ordinals: parserOrdinals,
      },
    },
  }
}

/** Deserialize like a RAW read: a fresh object graph, never the stored references. */
function cloned<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('replayedIdentityPageRankAnchors', () => {
  const rowCounts = [3, 2, 0]
  const pages = storedPages(rowCounts)
  const manifest = manifestFor(pages, rowCounts, [1, 2])

  it('anchors canonically equal cloned parser pages on the recorded source row counts', () => {
    expect(
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned(pages.slice(0, 2)),
        manifest,
      })
    ).toEqual([
      { sourcePageOrdinal: 1, rankBase: 0, sourceRowCount: 3 },
      { sourcePageOrdinal: 2, rankBase: 3, sourceRowCount: 2 },
    ])
  })

  it('rejects a tampered parser page', () => {
    const parsePages = cloned(pages.slice(0, 2))
    ;(parsePages[1].payload as { items: unknown[] }).items.pop()
    expect(() =>
      replayedIdentityPageRankAnchors({ sourcePages: cloned(pages), parsePages, manifest })
    ).toThrow('not bound to its stored source page')
  })

  it('rejects a stored source page whose payload no longer matches the manifest hash', () => {
    const sourcePages = cloned(pages)
    const parsePages = cloned(pages.slice(0, 2))
    ;(sourcePages[0].payload as { items: unknown[] }).items.pop()
    ;(parsePages[0].payload as { items: unknown[] }).items.pop()
    expect(() => replayedIdentityPageRankAnchors({ sourcePages, parsePages, manifest })).toThrow(
      'not bound to its stored source page'
    )
  })

  it('rejects reordered parser pages and reordered ordinals', () => {
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned([pages[1], pages[0]]),
        manifest,
      })
    ).toThrow('not bound to its stored source page')
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned([pages[1], pages[0]]),
        manifest: manifestFor(pages, rowCounts, [2, 1]),
      })
    ).toThrow('continuous source prefix')
  })

  it('rejects a missing parser page, a skipped ordinal and a missing stored page', () => {
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned(pages.slice(0, 1)),
        manifest,
      })
    ).toThrow('one source-page ordinal each')
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned([pages[0], pages[2]]),
        manifest: manifestFor(pages, rowCounts, [1, 3]),
      })
    ).toThrow('continuous source prefix')
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages.slice(0, 2)),
        parsePages: cloned(pages.slice(0, 2)),
        manifest,
      })
    ).toThrow('one source-page ordinal each')
  })

  it('rejects an empty parser page and a non-identity transformation', () => {
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned(pages),
        manifest: manifestFor(pages, rowCounts, [1, 2, 3]),
      })
    ).toThrow('positive source row count')
    const deduped = manifestFor(pages, rowCounts, [1, 2])
    expect(() =>
      replayedIdentityPageRankAnchors({
        sourcePages: cloned(pages),
        parsePages: cloned(pages.slice(0, 2)),
        manifest: {
          ...deduped,
          parser_input: {
            ...deduped.parser_input,
            transformation: {
              kind: 'dedupe_rechunk',
              source_page_ordinals: [1, 2],
              algorithm_contract: 'x',
              output_row_count: 5,
              output_page_size: 5,
            },
          },
        } as never,
      })
    ).toThrow('identity projection')
  })
})
