-- Canonical repost model
--
-- Reposts have been represented as rows in public.posts with
-- original_post_id since 2026-01. The legacy public.reposts table is no longer
-- written, but several readers and repost_count still assumed that old model.
-- Make posts.original_post_id the enforced source of truth and maintain the
-- root post's cached count for hot-score/read performance.

BEGIN;

-- The abandoned table must not silently diverge from the canonical model.
-- Production was audited at zero rows. Fail in an older environment so its
-- owner can migrate any real user data deliberately, then close all old writes.
DO $$
DECLARE
  v_has_legacy_rows boolean;
BEGIN
  IF to_regclass('public.reposts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.reposts)' INTO v_has_legacy_rows;
    IF v_has_legacy_rows THEN
      RAISE EXCEPTION
        'legacy public.reposts contains rows; migrate them before enabling canonical reposts';
    END IF;

    EXECUTE 'DROP POLICY IF EXISTS "Users can insert their own reposts" ON public.reposts';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete their own reposts" ON public.reposts';
    EXECUTE 'DROP POLICY IF EXISTS reposts_insert_own ON public.reposts';
    EXECUTE 'DROP POLICY IF EXISTS reposts_delete_own ON public.reposts';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.reposts FROM anon, authenticated';
  END IF;
END
$$;

-- Do not silently delete user-authored duplicate repost posts. Production was
-- audited clean before this migration; fail loudly in any drifted environment
-- so an owner can choose how to reconcile its data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.posts
    WHERE original_post_id IS NOT NULL
      AND deleted_at IS NULL
    GROUP BY author_id, original_post_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate active reposts exist for (author_id, original_post_id); reconcile before migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS repost
    LEFT JOIN public.posts AS root ON root.id = repost.original_post_id
    WHERE repost.original_post_id IS NOT NULL
      AND (
        root.id IS NULL
        OR repost.id = repost.original_post_id
        OR root.original_post_id IS NOT NULL
        OR repost.author_id = root.author_id
        OR root.deleted_at IS NOT NULL
        OR root.visibility IS DISTINCT FROM 'public'
        OR root.group_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'invalid canonical repost exists (missing/private/group/deleted/nested/self-author root)';
  END IF;
END
$$;

-- A repost is derivative of its root. SET NULL turned it into an independent
-- post that retained `RT: <private/deleted title>` after the root disappeared.
-- Cascade instead, matching the existing hard-delete product semantics.
ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_original_post_id_fkey;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_original_post_id_fkey
  FOREIGN KEY (original_post_id) REFERENCES public.posts(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_posts_active_repost_author_root
  ON public.posts (author_id, original_post_id)
  WHERE original_post_id IS NOT NULL AND deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'posts_repost_cannot_reference_self'
      AND conrelid = 'public.posts'::regclass
  ) THEN
    ALTER TABLE public.posts
      ADD CONSTRAINT posts_repost_cannot_reference_self
      CHECK (original_post_id IS NULL OR original_post_id <> id);
  END IF;
END
$$;

-- Direct authenticated PostgREST inserts must create ordinary posts only. The
-- service-role API below is the one canonical repost writer and performs the
-- product checks that RLS cannot express safely across rows.
DROP POLICY IF EXISTS posts_insert_no_direct_reposts ON public.posts;
CREATE POLICY posts_insert_no_direct_reposts
  ON public.posts
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (original_post_id IS NULL);

-- Preserve the root's sensitive-content gate on every derivative wrapper.
UPDATE public.posts AS repost
SET
  is_sensitive = TRUE,
  content_warning = COALESCE(repost.content_warning, root.content_warning)
FROM public.posts AS root
WHERE repost.original_post_id = root.id
  AND root.is_sensitive IS TRUE
  AND repost.is_sensitive IS NOT TRUE;

CREATE OR REPLACE FUNCTION public.enforce_canonical_repost()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_root public.posts%ROWTYPE;
BEGIN
  -- RLS blocks direct inserts. This also prevents an authenticated caller from
  -- mutating an existing ordinary/repost row into another canonical identity.
  IF current_user = 'authenticated'
     AND NEW.original_post_id IS DISTINCT FROM (
       CASE WHEN TG_OP = 'INSERT' THEN NULL::uuid ELSE OLD.original_post_id END
     ) THEN
    RAISE EXCEPTION 'canonical repost identity is API-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.original_post_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_root
  FROM public.posts
  WHERE id = NEW.original_post_id;

  IF NOT FOUND
     OR v_root.deleted_at IS NOT NULL
     OR v_root.original_post_id IS NOT NULL
     OR v_root.visibility IS DISTINCT FROM 'public'
     OR v_root.group_id IS NOT NULL THEN
    RAISE EXCEPTION 'repost root must be an active public root post'
      USING ERRCODE = '23514';
  END IF;

  IF v_root.author_id = NEW.author_id THEN
    RAISE EXCEPTION 'authors cannot repost their own root post'
      USING ERRCODE = '23514';
  END IF;

  IF v_root.is_sensitive IS TRUE AND NEW.is_sensitive IS NOT TRUE THEN
    RAISE EXCEPTION 'repost must preserve the root sensitive-content gate'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_canonical_repost() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_canonical_repost() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_canonical_repost() FROM authenticated;

DROP TRIGGER IF EXISTS trg_enforce_canonical_repost ON public.posts;
CREATE TRIGGER trg_enforce_canonical_repost
BEFORE INSERT OR UPDATE OF author_id, original_post_id, deleted_at, is_sensitive
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_canonical_repost();

CREATE OR REPLACE FUNCTION public.sync_post_repost_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_root_id uuid;
  v_new_root_id uuid;
BEGIN
  IF TG_OP <> 'INSERT'
     AND OLD.original_post_id IS NOT NULL
     AND OLD.deleted_at IS NULL THEN
    v_old_root_id := OLD.original_post_id;
  END IF;

  IF TG_OP <> 'DELETE'
     AND NEW.original_post_id IS NOT NULL
     AND NEW.deleted_at IS NULL THEN
    v_new_root_id := NEW.original_post_id;
  END IF;

  -- An UPDATE that leaves the active canonical root unchanged has no effect on
  -- its count. Avoid touching the root row in that common no-op case.
  IF v_old_root_id IS NOT DISTINCT FROM v_new_root_id THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Lock both affected roots in UUID order so simultaneous root moves cannot
  -- deadlock. The following arithmetic UPDATEs are atomic, unlike a trigger
  -- that recounts rows from a statement snapshot and can lose concurrent
  -- inserts.
  PERFORM 1
  FROM public.posts
  WHERE id IN (v_old_root_id, v_new_root_id)
  ORDER BY id
  FOR UPDATE;

  IF v_old_root_id IS NOT NULL THEN
    UPDATE public.posts
    SET repost_count = GREATEST(COALESCE(repost_count, 0) - 1, 0)
    WHERE id = v_old_root_id;
  END IF;

  IF v_new_root_id IS NOT NULL THEN
    UPDATE public.posts
    SET repost_count = COALESCE(repost_count, 0) + 1
    WHERE id = v_new_root_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_repost_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_post_repost_count() FROM anon;
REVOKE ALL ON FUNCTION public.sync_post_repost_count() FROM authenticated;

DROP TRIGGER IF EXISTS trg_sync_post_repost_count ON public.posts;
CREATE TRIGGER trg_sync_post_repost_count
AFTER INSERT OR DELETE OR UPDATE OF original_post_id, deleted_at
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.sync_post_repost_count();

-- Repair every cached count from the canonical rows. This intentionally also
-- clears stale non-zero counts left by the abandoned legacy reposts table.
UPDATE public.posts AS root
SET repost_count = counts.repost_count
FROM (
  SELECT
    root_post.id,
    COUNT(repost.id) FILTER (WHERE repost.deleted_at IS NULL)::integer AS repost_count
  FROM public.posts AS root_post
  LEFT JOIN public.posts AS repost
    ON repost.original_post_id = root_post.id
  GROUP BY root_post.id
) AS counts
WHERE root.id = counts.id
  AND root.repost_count IS DISTINCT FROM counts.repost_count;

COMMIT;
