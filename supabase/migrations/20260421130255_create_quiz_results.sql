-- Migration: 20260421130255_create_quiz_results.sql
-- Created: 2026-04-21T20:02:55Z
-- Description: Trading Personality Quiz results table for storing quiz completions

CREATE TABLE IF NOT EXISTS quiz_results (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text NOT NULL,
  primary_type text NOT NULL CHECK (primary_type IN ('sniper','scalper','whale','analyst','contrarian','hodler','degen','strategist')),
  secondary_type text CHECK (secondary_type IS NULL OR secondary_type IN ('sniper','scalper','whale','analyst','contrarian','hodler','degen','strategist')),
  match_percent int,
  scores jsonb,
  answers jsonb,
  language text DEFAULT 'en',
  created_at timestamptz DEFAULT now(),
  CONSTRAINT quiz_results_session_id_unique UNIQUE (session_id)
);

CREATE INDEX idx_quiz_results_type ON quiz_results(primary_type);
CREATE INDEX idx_quiz_results_created ON quiz_results(created_at DESC);
CREATE INDEX idx_quiz_results_user_id ON quiz_results(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE quiz_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quiz_insert" ON quiz_results
  FOR INSERT WITH CHECK (true);

CREATE POLICY "quiz_select_own" ON quiz_results
  FOR SELECT USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
