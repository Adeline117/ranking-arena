import { ingestClientConnect, type IngestQueryExecutor } from '@/lib/ingest/db'

/**
 * Short worker-owned transaction for immutable history evidence. A failed
 * body is rolled back; an ambiguous COMMIT destroys the checked-out client so
 * it can never be reused as if the outcome were known.
 */
export async function runHistoryTransaction<T>(
  operation: (transaction: IngestQueryExecutor) => Promise<T>
): Promise<T> {
  const client = await ingestClientConnect()
  let transactionOpen = false
  let commitAttempted = false
  let destroyClient = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const result = await operation(client)
    commitAttempted = true
    await client.query('COMMIT')
    transactionOpen = false
    return result
  } catch (cause) {
    if (commitAttempted) {
      destroyClient = true
      throw cause
    }
    let failure: unknown = cause
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackCause) {
        destroyClient = true
        failure = new AggregateError(
          [
            cause instanceof Error ? cause : new Error(String(cause)),
            rollbackCause instanceof Error ? rollbackCause : new Error(String(rollbackCause)),
          ],
          '[ingest] history transaction and rollback both failed'
        )
      }
    }
    throw failure
  } finally {
    client.release(destroyClient)
  }
}
