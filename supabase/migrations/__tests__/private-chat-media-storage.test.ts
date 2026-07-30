/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260729162000_private_chat_media_storage.sql'),
  'utf8'
)

describe('private chat media storage migration', () => {
  it('converges chat to a private, bounded, allow-listed bucket', () => {
    expect(migration).toContain("'chat',\n  'chat',\n  false,\n  52428800")
    expect(migration).toContain('allowed_mime_types = EXCLUDED.allowed_mime_types')
    expect(migration).toContain("'video/mp4'")
    expect(migration).toContain("'application/pdf'")
  })

  it('installs a restrictive owner-mode browser barrier and service-only policy', () => {
    expect(migration).toMatch(
      /CREATE POLICY "Non-service roles cannot access chat media"[\s\S]*AS RESTRICTIVE[\s\S]*TO PUBLIC[\s\S]*bucket_id <> 'chat'/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages chat media"[\s\S]*AS PERMISSIVE[\s\S]*TO service_role[\s\S]*bucket_id = 'chat'/
    )
  })

  it('fails managed rollout when a browser policy cannot be proven chat-exclusive', () => {
    expect(migration).toContain('pg_temp.chat_policy_excludes_chat')
    expect(migration).toContain('managed storage policy % can authorize chat')
    expect(migration).toContain('browser roles must remain behind storage.objects RLS')
  })

  it('locks bucket and object policy state before converging the contract', () => {
    expect(migration).toContain('LOCK TABLE storage.buckets IN ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain("hashtextextended('private-chat-media-storage@1', 0)")
  })
})
