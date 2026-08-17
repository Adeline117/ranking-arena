import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260817050000_arena_bot_legacy_publication_isolation.sql'
  ),
  'utf8'
)
const proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/arena-bot-legacy-publication-isolation.pg17.sh'
  ),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

const BOT_AUTHOR_ID = '00000000-0000-0000-0000-000000000001'
const quarantineUpdate = migration.match(
  /UPDATE public\.posts[\s\S]*?;\n\n-- No live bot post/
)?.[0]

describe('arena_bot legacy publication isolation migration', () => {
  it('is a forward migration after the existing notification fence', () => {
    expect(migration).toContain('20260817-arena-bot-legacy-publication-isolation')
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain('COMMIT;')
  })

  it('soft-quarantines only the fixed system UUID without a handle/body heuristic', () => {
    expect(quarantineUpdate).toBeDefined()
    expect(quarantineUpdate).toContain(`author_id = '${BOT_AUTHOR_ID}'::uuid`)
    expect(quarantineUpdate).toContain("status = 'deleted'::public.post_status")
    expect(quarantineUpdate).toContain('deleted_at = COALESCE(deleted_at')
    expect(quarantineUpdate).toContain("delete_reason = 'unverified_legacy_arena_bot_publication'")
    expect(quarantineUpdate).not.toMatch(/author_handle|title|content|ILIKE/i)
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.posts/i)
  })

  it('serializes the cutover and prevents live, restored, or reattributed bot rows', () => {
    expect(migration).toContain('LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_posts_16_reject_unverified_arena_bot_publication\s+BEFORE INSERT OR UPDATE\s+ON public\.posts/
    )
    expect(migration).toContain("TG_OP NOT IN ('INSERT', 'UPDATE')")
    expect(migration).toContain('OLD.author_id = v_arena_bot_author_id')
    expect(migration).toContain("NEW.status IS DISTINCT FROM 'deleted'::public.post_status")
    expect(migration).toContain('arena_bot publication receipt is required')
  })

  it('adds the bot deny to the canonical reader and keeps internal helpers private', () => {
    expect(migration).toContain(`p_author_id = '${BOT_AUTHOR_ID}'::uuid`)
    expect(migration).toContain('canonical post audience reader source changed under lock')
    expect(migration).toContain('DO $converge_internal_function_acl$')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE')
    expect(migration).toContain('arena_bot publication owner authority graph is unsafe')
    expect(migration).toContain('arena_bot publication function ACL drifted')
    expect(migration).toContain('arena_bot publication trigger is not enabled')
  })

  it('retires every raw weighted-search callable rather than leaving a public overload', () => {
    expect(migration).toContain("function_row.proname = 'search_posts_with_weight'")
    expect(migration).toContain("'ALTER FUNCTION %s OWNER TO postgres'")
    expect(migration).toContain('weighted post search ACL remains public')
  })

  it('runs the PostgreSQL 17 RLS, trigger, and ACL proof in CI', () => {
    expect(proof).toContain('arena_bot legacy publication isolation PG17 proof passed')
    expect(packageJson).toContain(
      '"qa:arena-bot-legacy-publication-isolation-pg17": "bash supabase/migrations/__tests__/arena-bot-legacy-publication-isolation.pg17.sh"'
    )
    expect(ciWorkflow).toContain('name: Prove arena_bot legacy-publication isolation')
    expect(ciWorkflow).toContain('run: npm run qa:arena-bot-legacy-publication-isolation-pg17')
  })
})
