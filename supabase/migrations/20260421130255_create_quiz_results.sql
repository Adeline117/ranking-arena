-- Migration: 20260421130255_create_quiz_results.sql
-- Created: 2026-04-21T20:02:55Z
-- Description: Trading Personality Quiz results table for storing quiz completions

CREATE TABLE IF NOT EXISTS quiz_results (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text NOT NULL,
  primary_type text NOT NULL,
  secondary_type text,
  match_percent int,
  scores jsonb,
  answers jsonb,
  language text DEFAULT 'en',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_quiz_results_type ON quiz_results(primary_type);
CREATE INDEX idx_quiz_results_created ON quiz_results(created_at DESC);

ALTER TABLE quiz_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quiz_insert" ON quiz_results
  FOR INSERT WITH CHECK (true);

CREATE POLICY "quiz_select_own" ON quiz_results
  FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);
