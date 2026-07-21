import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721130000_raw_object_gc_outbox.sql'),
  'utf8'
)

describe('RAW object GC outbox migration', () => {
  it('is an atomic additive migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('CREATE TABLE arena.raw_object_gc_queue')
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|FUNCTION|TRIGGER)/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('persists a detached immutable Storage deletion identity without a RAW FK', () => {
    expect(migration).toContain('raw_object_id bigint NOT NULL UNIQUE')
    expect(migration).toContain('storage_path text PRIMARY KEY')
    expect(migration).toContain('content_hash text NOT NULL')
    expect(migration).toContain(
      'enqueued_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()'
    )
    expect(migration).not.toMatch(/raw_object_id[^,\n]*REFERENCES\s+arena\.raw_objects/i)
    expect(migration).toContain('protect_raw_object_gc_queue_before_update')
    expect(migration).toContain('RAW object GC identity cannot be mutated')
  })

  it('retains validated failure attempts and supports stable retry selection', () => {
    expect(migration).toContain('attempts integer NOT NULL DEFAULT 0')
    expect(migration).toContain('last_attempt_at timestamptz')
    expect(migration).toContain('last_error text')
    expect(migration).toContain('raw_object_gc_queue_attempt_shape')
    expect(migration).toContain('NEW.attempts <> OLD.attempts + 1')
    expect(migration).toContain('idx_arena_raw_object_gc_queue_retry')
    expect(migration).toContain('COALESCE(last_attempt_at, enqueued_at)')
    expect(migration).toMatch(/enqueued_at,\s*storage_path\s*\n\s*\)/)
  })

  it('is private and gives service role only the worker columns it needs', () => {
    expect(migration).toContain('ALTER TABLE arena.raw_object_gc_queue ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('service_role must bypass RLS for the private RAW object GC queue')
    expect(migration).toContain(
      'REVOKE ALL ON TABLE arena.raw_object_gc_queue\n  FROM PUBLIC, anon, authenticated, service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT, DELETE ON TABLE arena.raw_object_gc_queue TO service_role'
    )
    expect(migration).toContain('GRANT INSERT (raw_object_id, storage_path, content_hash)')
    expect(migration).toContain('GRANT UPDATE (attempts, last_attempt_at, last_error)')
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|INSERT|UPDATE)[^;(]*ON TABLE arena\.raw_object_gc_queue TO service_role/i
    )
    expect(migration).toContain('RAW object GC queue leaked to a public role')
  })
})
