-- Migration: 20260421232915_fix_quiz_results_type_check_constraint.sql
-- Created: 2026-04-22T06:29:15Z
-- Description: Add missing personality types (copycat, tourist, paperhands, narrator)
--              to quiz_results CHECK constraints. The original migration only included
--              8 of 12 types, causing INSERT failures for those 4 types.

-- Drop the old constraints and re-add with all 12 types
ALTER TABLE quiz_results
  DROP CONSTRAINT IF EXISTS quiz_results_primary_type_check,
  ADD CONSTRAINT quiz_results_primary_type_check
    CHECK (primary_type IN (
      'sniper','scalper','whale','analyst','contrarian','hodler',
      'degen','strategist','copycat','tourist','paperhands','narrator'
    ));

ALTER TABLE quiz_results
  DROP CONSTRAINT IF EXISTS quiz_results_secondary_type_check,
  ADD CONSTRAINT quiz_results_secondary_type_check
    CHECK (secondary_type IS NULL OR secondary_type IN (
      'sniper','scalper','whale','analyst','contrarian','hodler',
      'degen','strategist','copycat','tourist','paperhands','narrator'
    ));
