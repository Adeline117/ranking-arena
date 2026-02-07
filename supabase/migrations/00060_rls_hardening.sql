-- RLS Hardening: Add missing policies for book_ratings and library_items
-- All tables already have RLS enabled; this adds explicit policies where missing.

-- ============================================================
-- book_ratings (equivalent to library_ratings)
-- ============================================================

-- Anyone can read ratings
CREATE POLICY "book_ratings_read_all" ON public.book_ratings
  FOR SELECT USING (true);

-- Users can insert their own ratings
CREATE POLICY "book_ratings_insert_own" ON public.book_ratings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own ratings
CREATE POLICY "book_ratings_update_own" ON public.book_ratings
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own ratings
CREATE POLICY "book_ratings_delete_own" ON public.book_ratings
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- library_items
-- ============================================================

-- Anyone can read library items
CREATE POLICY "library_items_read_all" ON public.library_items
  FOR SELECT USING (true);

-- Only service role / admin can modify library items (no user write policies)
-- This is intentional: library items are curated content.
