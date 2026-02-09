-- RLS Audit Fix: 2026-02-08
-- Tables with RLS enabled but NO policies (completely locked out)
-- Adding appropriate policies based on data sensitivity

-- ============================================================
-- CRITICAL: User-sensitive tables (contain user_id, secrets)
-- ============================================================

-- account_bindings: user's linked platform accounts
CREATE POLICY "Users can view own bindings" ON account_bindings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own bindings" ON account_bindings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own bindings" ON account_bindings FOR DELETE USING (auth.uid() = user_id);

-- backup_codes: 2FA backup codes (highly sensitive)
CREATE POLICY "Users can view own backup codes" ON backup_codes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own backup codes" ON backup_codes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own backup codes" ON backup_codes FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- login_sessions: user session data (sensitive)
CREATE POLICY "Users can view own sessions" ON login_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own sessions" ON login_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own sessions" ON login_sessions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own sessions" ON login_sessions FOR DELETE USING (auth.uid() = user_id);

-- oauth_states: OAuth flow state (sensitive, short-lived)
CREATE POLICY "Users can view own oauth states" ON oauth_states FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own oauth states" ON oauth_states FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own oauth states" ON oauth_states FOR DELETE USING (auth.uid() = user_id);

-- search_analytics: contains user_id
CREATE POLICY "Users can view own searches" ON search_analytics FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own searches" ON search_analytics FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- PUBLIC READ: Market/leaderboard data (no user secrets)
-- ============================================================

-- leaderboard_ranks: public ranking data
CREATE POLICY "Public read leaderboard_ranks" ON leaderboard_ranks FOR SELECT USING (true);

-- leaderboard_snapshots: public ranking snapshots
CREATE POLICY "Public read leaderboard_snapshots" ON leaderboard_snapshots FOR SELECT USING (true);

-- trader_scores: public scoring data
CREATE POLICY "Public read trader_scores" ON trader_scores FOR SELECT USING (true);

-- trader_seasons: public seasonal stats
CREATE POLICY "Public read trader_seasons" ON trader_seasons FOR SELECT USING (true);

-- funding_rates: public market data
CREATE POLICY "Public read funding_rates" ON funding_rates FOR SELECT USING (true);

-- liquidations: public market data
CREATE POLICY "Public read liquidations" ON liquidations FOR SELECT USING (true);

-- liquidation_stats: public aggregated data
CREATE POLICY "Public read liquidation_stats" ON liquidation_stats FOR SELECT USING (true);

-- market_benchmarks: public market data
CREATE POLICY "Public read market_benchmarks" ON market_benchmarks FOR SELECT USING (true);

-- market_conditions: public market data
CREATE POLICY "Public read market_conditions" ON market_conditions FOR SELECT USING (true);

-- open_interest: public market data
CREATE POLICY "Public read open_interest" ON open_interest FOR SELECT USING (true);

-- trader_merges: public metadata
CREATE POLICY "Public read trader_merges" ON trader_merges FOR SELECT USING (true);

-- ============================================================
-- INTERNAL/SERVICE ONLY: No client access needed
-- ============================================================

-- cron_logs: internal system logs
CREATE POLICY "Service role only cron_logs" ON cron_logs FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- pipeline_metrics: internal system metrics
CREATE POLICY "Service role only pipeline_metrics" ON pipeline_metrics FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- FIX: Overly permissive write policies on public role
-- These tables allow ANY public user to INSERT/UPDATE/DELETE
-- ============================================================

-- exp_transactions: ALL with true (fully open!)
-- Currently: service_manage_exp_transactions ALL true/true
-- This is intended for service role but applied to {public}
-- Fix: restrict to service_role
DROP POLICY IF EXISTS "service_manage_exp_transactions" ON exp_transactions;
CREATE POLICY "service_manage_exp_transactions" ON exp_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "users_read_own_exp" ON exp_transactions FOR SELECT USING (auth.uid() = user_id);

-- user_levels: ALL with true (fully open!)
DROP POLICY IF EXISTS "service_manage_levels" ON user_levels;
CREATE POLICY "service_manage_levels" ON user_levels FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Keep existing public_read_levels and users_read_own_level

-- translation_cache: ALL true/true to public (anyone can write!)
DROP POLICY IF EXISTS "Service role can manage translation cache" ON translation_cache;
CREATE POLICY "Service role manage translation_cache" ON translation_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Keep existing public SELECT policy

-- trader_follows: ALL true to public (anyone can manipulate follows!)
DROP POLICY IF EXISTS "Service can manage" ON trader_follows;
CREATE POLICY "Service manage trader_follows" ON trader_follows FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Users can follow traders" ON trader_follows FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can unfollow traders" ON trader_follows FOR DELETE USING (auth.uid() = user_id);
-- Keep existing public SELECT policy

-- notifications: INSERT with true (anyone can insert notifications)
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "Service can insert notifications" ON notifications;
CREATE POLICY "Service can insert notifications" ON notifications FOR INSERT TO service_role WITH CHECK (true);

-- polls: INSERT with true (anyone can create polls without auth check)
DROP POLICY IF EXISTS "Authenticated users can create polls" ON polls;
CREATE POLICY "Authenticated users can create polls" ON polls FOR INSERT TO authenticated WITH CHECK (true);

-- poll_votes: INSERT/DELETE with true (no ownership check)
DROP POLICY IF EXISTS "Users can vote" ON poll_votes;
DROP POLICY IF EXISTS "Users can delete vote" ON poll_votes;
CREATE POLICY "Users can vote" ON poll_votes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own vote" ON poll_votes FOR DELETE USING (auth.uid() = user_id);

-- trader_asset_breakdown/equity_curve/portfolio/stats_detail: INSERT/UPDATE true to public
-- These are service-written tables, restrict writes to service_role
DROP POLICY IF EXISTS "Service insert trader_asset_breakdown" ON trader_asset_breakdown;
DROP POLICY IF EXISTS "Service update trader_asset_breakdown" ON trader_asset_breakdown;
CREATE POLICY "Service write trader_asset_breakdown" ON trader_asset_breakdown FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service insert trader_equity_curve" ON trader_equity_curve;
DROP POLICY IF EXISTS "Service update trader_equity_curve" ON trader_equity_curve;
CREATE POLICY "Service write trader_equity_curve" ON trader_equity_curve FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service insert trader_portfolio" ON trader_portfolio;
DROP POLICY IF EXISTS "Service update trader_portfolio" ON trader_portfolio;
CREATE POLICY "Service write trader_portfolio" ON trader_portfolio FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service insert trader_stats_detail" ON trader_stats_detail;
DROP POLICY IF EXISTS "Service update trader_stats_detail" ON trader_stats_detail;
CREATE POLICY "Service write trader_stats_detail" ON trader_stats_detail FOR ALL TO service_role USING (true) WITH CHECK (true);

-- trader_snapshots/roi_history/frequently_traded: same issue
DROP POLICY IF EXISTS "Service role can insert" ON trader_snapshots;
DROP POLICY IF EXISTS "Service role can update" ON trader_snapshots;
DROP POLICY IF EXISTS "Service role can delete" ON trader_snapshots;
CREATE POLICY "Service write trader_snapshots" ON trader_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can insert" ON trader_roi_history;
DROP POLICY IF EXISTS "Service role can update" ON trader_roi_history;
DROP POLICY IF EXISTS "Service role can delete" ON trader_roi_history;
CREATE POLICY "Service write trader_roi_history" ON trader_roi_history FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can insert" ON trader_frequently_traded;
DROP POLICY IF EXISTS "Service role can update" ON trader_frequently_traded;
DROP POLICY IF EXISTS "Service role can delete" ON trader_frequently_traded;
CREATE POLICY "Service write trader_frequently_traded" ON trader_frequently_traded FOR ALL TO service_role USING (true) WITH CHECK (true);

-- trader_sources: INSERT/UPDATE true to public
DROP POLICY IF EXISTS "Service role can insert" ON trader_sources;
DROP POLICY IF EXISTS "Service role can update" ON trader_sources;
CREATE POLICY "Service write trader_sources" ON trader_sources FOR ALL TO service_role USING (true) WITH CHECK (true);
