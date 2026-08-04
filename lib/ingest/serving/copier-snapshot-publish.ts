import type { ParsedHistoryRow } from '../core/types'
import type { IngestQueryExecutor } from '../db'
import type { RawObjectReceipt } from '../raw'
import {
  copierSnapshotSourceRunId,
  copierSnapshotStoragePath,
  revalidateCopierSnapshotArtifact,
  type CopierSnapshotArtifact,
} from '../copier-snapshot-artifact'

type ParsedCopierRow = Extract<ParsedHistoryRow, { kind: 'copiers' }>

export interface PublishCopierSnapshotInput {
  artifact: CopierSnapshotArtifact
  rawReceipt: RawObjectReceipt
  rows: readonly ParsedHistoryRow[]
}

export interface CopierSnapshotPublicationReceipt {
  publicationId: number
  publishedAt: string
  parsedRowCount: number
  replayed: boolean
}

interface CopierSnapshotPublisherRow {
  publication_id: number
  published_at: string
  parsed_row_count: number
  replayed: boolean
}

interface PreparedCopierRow {
  row_ordinal: number
  source_event_at: null
  copier_label: string | null
  copier_pnl: number | null
  copier_invested: number | null
  copy_duration_days: number | null
  dedupe_hash: string
}

function publicationError(detail: string): Error {
  return new Error(`[publish] copier snapshot failed: ${detail}`)
}

function assertNullableFiniteNumber(
  value: number | null,
  label: string,
  options: { nonnegative?: boolean } = {}
): void {
  if (value === null) return
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw publicationError(`${label} must be a finite canonical number or null`)
  }
  if (options.nonnegative && value < 0) {
    throw publicationError(`${label} must be nonnegative or null`)
  }
}

function prepareCopierRows(rows: readonly ParsedHistoryRow[]): PreparedCopierRow[] {
  if (rows.length > 10000000) throw publicationError('row count exceeds the contract limit')
  if (rows.some((row) => row.kind !== 'copiers')) {
    throw publicationError('row kind does not match copiers')
  }

  const seenDedupeHashes = new Set<string>()
  return (rows as readonly ParsedCopierRow[]).map((row, rowOrdinal) => {
    if (
      row.copierLabel !== null &&
      (row.copierLabel !== row.copierLabel.trim() ||
        row.copierLabel.length < 1 ||
        row.copierLabel.length > 512)
    ) {
      throw publicationError(`row ${rowOrdinal} copier label is not canonical`)
    }
    if (
      typeof row.dedupeHash !== 'string' ||
      row.dedupeHash !== row.dedupeHash.trim() ||
      row.dedupeHash.length < 1 ||
      row.dedupeHash.length > 512
    ) {
      throw publicationError(`row ${rowOrdinal} dedupe hash is not canonical`)
    }
    if (seenDedupeHashes.has(row.dedupeHash)) {
      throw publicationError(`duplicate copier dedupe hash at row ${rowOrdinal}`)
    }
    seenDedupeHashes.add(row.dedupeHash)

    assertNullableFiniteNumber(row.copierPnl, `row ${rowOrdinal} copier PnL`)
    assertNullableFiniteNumber(row.copierInvested, `row ${rowOrdinal} copier invested`, {
      nonnegative: true,
    })
    if (
      row.copyDurationDays !== null &&
      (!Number.isSafeInteger(row.copyDurationDays) || row.copyDurationDays < 0)
    ) {
      throw publicationError(`row ${rowOrdinal} copy duration must be a nonnegative integer`)
    }

    return {
      row_ordinal: rowOrdinal,
      // Current adapters overload row.ts with the capture time. Until a parser
      // exposes reviewed source-event provenance, storing it here would lie.
      source_event_at: null,
      copier_label: row.copierLabel,
      copier_pnl: row.copierPnl,
      copier_invested: row.copierInvested,
      copy_duration_days: row.copyDurationDays,
      dedupe_hash: row.dedupeHash,
    }
  })
}

function validateRawReceipt(artifact: CopierSnapshotArtifact, receipt: RawObjectReceipt): void {
  if (!Number.isSafeInteger(receipt.id) || receipt.id <= 0) {
    throw publicationError('RAW receipt id is invalid')
  }
  const sourceRunId = copierSnapshotSourceRunId(artifact)
  const expectedPath = copierSnapshotStoragePath(artifact)
  if (receipt.contentHash !== sourceRunId || receipt.storagePath !== expectedPath) {
    throw publicationError('RAW receipt does not match the canonical artifact')
  }
}

/**
 * Caller-owned transaction body. PostgreSQL rechecks all live identities and
 * owns the receipt/row hashes; this wrapper never writes authority tables
 * directly and never issues BEGIN, COMMIT, or ROLLBACK.
 */
export async function publishCopierSnapshotInTransaction(
  transaction: IngestQueryExecutor,
  input: PublishCopierSnapshotInput
): Promise<CopierSnapshotPublicationReceipt> {
  const artifact = revalidateCopierSnapshotArtifact(input.artifact)
  validateRawReceipt(artifact, input.rawReceipt)
  const rows = prepareCopierRows(input.rows)

  const result = await transaction.query<CopierSnapshotPublisherRow>(
    `SELECT publication_id,
            published_at::text AS published_at,
            parsed_row_count,
            replayed
       FROM arena.publish_copier_snapshot(
         $1::smallint,
         $2::bigint,
         $3::text,
         $4::bigint,
         $5::text,
         $6::text,
         $7::timestamptz,
         $8::boolean,
         $9::integer,
         $10::integer,
         $11::jsonb
       )`,
    [
      artifact.source.id,
      artifact.trader.id,
      artifact.lane,
      input.rawReceipt.id,
      input.rawReceipt.storagePath,
      input.rawReceipt.contentHash,
      artifact.observed_at,
      artifact.caller_limited,
      artifact.page_count,
      artifact.source_reported_row_count,
      JSON.stringify(rows),
    ]
  )

  if (result.rows.length !== 1) {
    throw publicationError(`database returned ${result.rows.length} publication receipts`)
  }
  const receipt = result.rows[0]
  if (
    !Number.isSafeInteger(receipt.publication_id) ||
    receipt.publication_id <= 0 ||
    !Number.isFinite(Date.parse(receipt.published_at)) ||
    !Number.isSafeInteger(receipt.parsed_row_count) ||
    receipt.parsed_row_count !== rows.length ||
    typeof receipt.replayed !== 'boolean'
  ) {
    throw publicationError('database receipt violates the publication contract')
  }

  return {
    publicationId: receipt.publication_id,
    publishedAt: receipt.published_at,
    parsedRowCount: receipt.parsed_row_count,
    replayed: receipt.replayed,
  }
}
