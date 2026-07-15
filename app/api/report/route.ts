import { withAuth } from '@/lib/api/middleware'
import { badRequest, conflict, serverError, success } from '@/lib/api/response'
import {
  CommentMutationRolloutError,
  moderateCommentWithRollout,
} from '@/lib/data/comment-mutation-rollout'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('report-api')

export const dynamic = 'force-dynamic'

const VALID_TYPES = ['post', 'comment', 'profile']
const VALID_REASONS = ['spam', 'scam', 'harassment', 'misinformation', 'nsfw', 'other']

// Auto-hide thresholds, expressed in WEIGHTED report units (not raw counts).
// Each reporter contributes at most 1.0, and throwaway/low-trust accounts
// contribute a small fraction (see reporterWeight below). This defeats the
// bot-swarm attack where 3 fresh accounts could auto-remove any real content:
// a swarm of brand-new accounts now sums to a tiny weighted score, far below
// these thresholds, while genuine aged reporters each count ~1.0.
const POST_REPORT_WEIGHT_THRESHOLD = 5
const COMMENT_REPORT_WEIGHT_THRESHOLD = 4

/**
 * Trust weight for a single reporter, in [0, 1].
 * Younger accounts and negative-reputation accounts are discounted so that a
 * pile of throwaway bot reports cannot cross the auto-remove threshold.
 */
function reporterWeight(
  profile: { created_at: string | null; reputation_score: number | null } | undefined,
  now: number
): number {
  if (!profile) return 0.25 // unknown/missing profile — low trust
  let w = 1
  const ageMs = profile.created_at ? now - new Date(profile.created_at).getTime() : 0
  const ageDays = ageMs / 86_400_000
  if (ageDays < 1) w = 0.1
  else if (ageDays < 7) w = 0.35
  else if (ageDays < 30) w = 0.7
  const rep = profile.reputation_score ?? 0
  if (rep < 0) w *= 0.5 // net-negative reputation → half trust
  return w
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { content_type, content_id, reason, description } = body as {
      content_type?: string
      content_id?: string
      reason?: string
      description?: string
    }

    if (!content_type || !VALID_TYPES.includes(content_type)) {
      return badRequest('Invalid content type')
    }
    if (!reason || !VALID_REASONS.includes(reason)) {
      return badRequest('Invalid report reason')
    }
    if (!content_id) {
      return badRequest('Missing content ID')
    }

    // Check duplicate report
    const { data: existing } = await supabase
      .from('content_reports')
      .select('id')
      .eq('reporter_id', user.id)
      .eq('content_type', content_type)
      .eq('content_id', content_id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return conflict('You have already reported this content')
    }

    const { error } = await supabase.from('content_reports').insert({
      reporter_id: user.id,
      content_type,
      content_id,
      reason,
      description: description || null,
    })

    if (error) {
      logger.error('insert failed', { error: error.message })
      return serverError('Submission failed')
    }

    // Auto-hide: compute a WEIGHTED report score (per-reporter trust) and only
    // auto-hide when it crosses the threshold. Comments are SOFT-deleted
    // (recoverable, audited) — NEVER hard-deleted from user reports.
    let moderationStatus: 'not_required' | 'applied' | 'pending' = 'not_required'
    try {
      // Pull the distinct pending reporters for this content, then weight each
      // by account age + reputation so bot swarms can't cross the threshold.
      const { data: pendingReports, error: pendingReportsError } = await supabase
        .from('content_reports')
        .select('reporter_id')
        .eq('content_type', content_type)
        .eq('content_id', content_id)
        .eq('status', 'pending')

      if (pendingReportsError) throw pendingReportsError

      const reporterIds = [...new Set((pendingReports || []).map((r) => r.reporter_id))]

      let weightedScore = 0
      if (reporterIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('user_profiles')
          .select('id, created_at, reputation_score')
          .in('id', reporterIds)

        if (profilesError) throw profilesError

        const profileMap = new Map(
          (profiles || []).map((p) => [
            p.id,
            { created_at: p.created_at, reputation_score: p.reputation_score },
          ])
        )
        const now = Date.now()
        for (const id of reporterIds) {
          weightedScore += reporterWeight(profileMap.get(id), now)
        }
      }

      if (content_type === 'post' && weightedScore >= POST_REPORT_WEIGHT_THRESHOLD) {
        await supabase
          .from('posts')
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: null,
            delete_reason: `Auto-hidden: weighted report score ${weightedScore.toFixed(1)} (${reporterIds.length} reporters)`,
          })
          .eq('id', content_id)
          .is('deleted_at', null)
        logger.info(
          `Auto-hidden post ${content_id} (weighted ${weightedScore.toFixed(1)}, ${reporterIds.length} reporters)`
        )
      } else if (content_type === 'comment' && weightedScore >= COMMENT_REPORT_WEIGHT_THRESHOLD) {
        const hideReason = `Auto-hidden: weighted report score ${weightedScore.toFixed(1)} (${reporterIds.length} reporters)`
        await moderateCommentWithRollout(supabase, {
          commentId: content_id,
          actorId: null,
          action: 'soft_delete',
          reason: hideReason,
        })
        moderationStatus = 'applied'
        logger.info(
          `Auto-hidden comment ${content_id} (weighted ${weightedScore.toFixed(1)}, ${reporterIds.length} reporters)`
        )
      }
    } catch (autoHideErr) {
      // Non-blocking: report was saved successfully, auto-hide is best-effort
      moderationStatus = 'pending'
      logger.warn('Auto-hide check failed', {
        ...(autoHideErr instanceof CommentMutationRolloutError
          ? {
              kind: autoHideErr.kind,
              code: autoHideErr.databaseCode,
              stage: autoHideErr.stage,
            }
          : { error: autoHideErr instanceof Error ? autoHideErr.message : String(autoHideErr) }),
      })
    }

    return success({
      ok: true,
      ...(content_type === 'comment' ? { moderation_status: moderationStatus } : {}),
    })
  },
  { name: 'report', rateLimit: 'write' }
)
