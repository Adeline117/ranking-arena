/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260729185500_post_media_storage.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/post-media-storage.pg17.sh'),
  'utf8'
)
const imageUpload = readFileSync(
  resolve(process.cwd(), 'app/api/posts/upload-image/route.ts'),
  'utf8'
)
const imageSniffer = readFileSync(resolve(process.cwd(), 'lib/utils/image-magic-bytes.ts'), 'utf8')
const videoUpload = readFileSync(
  resolve(process.cwd(), 'app/api/posts/upload-video/route.ts'),
  'utf8'
)
const videoSniffer = readFileSync(resolve(process.cwd(), 'lib/utils/video-magic-bytes.ts'), 'utf8')

const expectedMimes = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
]

describe('post media storage migration', () => {
  it('is a bounded replayable predeploy transaction', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('-- Phase: predeploy.')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("hashtextextended('public-post-media-storage@1', 0)")
    expect(migration).toContain('LOCK TABLE storage.buckets IN ROW EXCLUSIVE MODE')
    expect(migration).toContain('LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('Supabase Storage bucket identity constraints drifted')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('converges one public 100 MiB posts bucket to sniff-produced MIME types', () => {
    expect(migration).toContain("'posts',\n  'posts',\n  true,\n  104857600")
    expect(migration).toContain('allowed_mime_types = EXCLUDED.allowed_mime_types')

    const bucketValues = migration.match(
      /\) VALUES \([\s\S]*?104857600,\s*ARRAY\[([\s\S]*?)\]::text\[\]\s*\)\s*ON CONFLICT \(id\)/
    )?.[1]
    expect(bucketValues).toBeDefined()
    const bucketMimes = [...bucketValues!.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(bucketMimes).toEqual(expectedMimes)

    expect(imageUpload).toContain("sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])")
    for (const mime of expectedMimes.slice(0, 5)) {
      expect(imageSniffer).toContain(`mime: '${mime}'`)
    }
    expect(videoUpload).toContain("import { sniffVideoFile } from '@/lib/utils/video-magic-bytes'")
    for (const mime of expectedMimes.slice(5)) {
      expect(videoSniffer).toContain(`mime: '${mime}'`)
    }
    for (const unsupported of ['image/jpg', 'image/svg+xml', 'text/html']) {
      expect(migration).not.toContain(`'${unsupported}'`)
    }
  })

  it('never rewrites objects and preserves managed table owners and grants', () => {
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+storage\.objects\b/i)
    expect(migration).not.toMatch(/\bUPDATE\s+storage\.objects\b/i)
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+storage\.objects\b/i)
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+storage\.(buckets|objects)[\s\S]*OWNER/i)
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE)\b[\s\S]{0,120}storage\.(?:buckets|objects)/i)
    expect(migration).toContain('app.post_media_bucket_owner')
    expect(migration).toContain('app.post_media_object_owner')
    expect(migration).toContain('app.post_media_bucket_acl')
    expect(migration).toContain('app.post_media_object_acl')
  })

  it('installs a restrictive owner boundary and a service management policy', () => {
    expect(migration).toMatch(
      /CREATE POLICY "Non-service roles cannot manage posts bucket"[\s\S]*AS RESTRICTIVE[\s\S]*TO PUBLIC[\s\S]*id <> 'posts'[\s\S]*CURRENT_USER = 'service_role'/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages posts bucket"[\s\S]*AS PERMISSIVE[\s\S]*TO service_role[\s\S]*id = 'posts'/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Non-service roles cannot access post media"[\s\S]*AS RESTRICTIVE[\s\S]*TO PUBLIC[\s\S]*bucket_id <> 'posts'[\s\S]*CURRENT_USER = 'service_role'/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages post media"[\s\S]*AS PERMISSIVE[\s\S]*TO service_role[\s\S]*bucket_id = 'posts'/
    )
    expect(migration).toContain('post media owner policy contract is invalid')
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*FOR SELECT[\s\S]*bucket_id = 'posts'/)
  })

  it('fails closed on identity and managed-policy ambiguity', () => {
    expect(migration).toContain("bucket.name = 'posts'")
    expect(migration).toContain("bucket.id <> 'posts'")
    expect(migration).toContain('posts bucket name belongs to a different bucket id')
    expect(migration).toContain('pg_temp.storage_policy_excludes_posts')
    expect(migration).toContain('managed storage policy % can authorize posts; restrict it first')
    expect(migration).toContain('browser roles must remain behind Supabase Storage RLS')
    expect(migration).toContain('browser role can assume the post media service role')
    expect(migration).toContain('browser role can assume the managed Storage owner')
  })

  it('contains PostgreSQL 17 creation, convergence, ACL, replay, and rollback proof', () => {
    for (const marker of [
      'failed rollout remained atomic',
      'missing bucket created',
      'drift converged without object loss',
      'browser direct storage access denied',
      'service object CRUD retained',
      'browser service-role escalation failed closed',
      'owner migration replay',
      'managed owner escalation failed closed',
      'managed ownership and grants retained',
      'managed browser boundary retained',
      'identity ambiguity failed closed',
      'unsafe managed bucket policy failed closed',
      'unsafe managed write policy failed closed',
      'unsafe managed policy failed closed',
      'post media storage PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
