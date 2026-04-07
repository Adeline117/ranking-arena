/**
 * AI Trader Analysis API
 * GET /api/traders/[handle]/ai-analyze?platform=xxx&lang=en
 *
 * Fetches trader metrics and sends them to GPT-4o-mini for a structured analysis.
 * Results are cached in Redis for 1 hour.
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { success as apiSuccess, handleError } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { resolveTrader, getTraderDetail } from '@/lib/data/unified'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('ai-analyze')

const handleSchema = z.string().min(1).max(255)

type Verdict = 'strong_buy' | 'buy' | 'neutral' | 'caution' | 'avoid'

interface AiAnalysis {
  summary: string
  strengths: string[]
  risks: string[]
  verdict: Verdict
}

/** Call OpenAI chat completions via raw fetch (no npm dependency needed) */
async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY) {
    throw ApiError.internal('AI analysis service is not configured')
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 800,
    }),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    logger.error('OpenAI API error', { status: response.status, error: errorData })
    throw new Error('AI service request failed')
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error('Empty response from AI')
  }

  return content
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  // Rate limit: sensitive preset (15/min)
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { handle: rawHandle } = await params
    const parsed = handleSchema.safeParse(rawHandle)
    if (!parsed.success) {
      throw ApiError.validation('Invalid handle parameter')
    }
    const handle = decodeURIComponent(parsed.data)

    const platform = request.nextUrl.searchParams.get('platform') || ''
    const lang = request.nextUrl.searchParams.get('lang') || 'en'

    const cacheKey = `ai-analyze:${handle.toLowerCase()}:${platform}:${lang}`

    const analysis = await tieredGetOrSet<AiAnalysis>(
      cacheKey,
      async () => {
        const supabase = getSupabaseAdmin()

        // Resolve trader
        const resolved = await resolveTrader(supabase, {
          handle,
          platform: platform || undefined,
        })

        if (!resolved) {
          throw ApiError.notFound(`Trader not found: ${handle}`)
        }

        // Get trader detail
        const detail = await getTraderDetail(supabase, {
          platform: resolved.platform,
          traderKey: resolved.traderKey,
        })

        if (!detail) {
          throw ApiError.notFound(`No data for trader: ${handle}`)
        }

        // Extract metrics from the trader object
        const trader = detail.trader
        const stats = detail.stats
        const metrics = {
          handle: trader.handle ?? handle,
          platform: trader.platform,
          roi: trader.roi,
          pnl: trader.pnl,
          winRate: trader.winRate,
          sharpeRatio: trader.sharpeRatio ?? stats?.sharpeRatio ?? null,
          maxDrawdown: trader.maxDrawdown,
          tradesCount: trader.tradesCount,
          arenaScore: trader.arenaScore,
          tradingStyle: trader.tradingStyle,
          avgHoldingHours: trader.avgHoldingHours ?? stats?.avgHoldingHours ?? null,
          profitFactor: trader.profitFactor,
        }

        const targetLanguage = lang === 'zh' ? 'Chinese (Simplified)' : 'English'

        const systemPrompt = `You are a professional crypto trading analyst. Analyze the trader's metrics and produce a structured analysis in ${targetLanguage}.

You MUST respond with valid JSON only (no markdown, no code fences). The JSON schema:
{
  "summary": "2-3 sentence overview of the trader's performance and style",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "verdict": "one of: strong_buy, buy, neutral, caution, avoid"
}

Guidelines:
- Be concise and specific. Reference actual numbers.
- strengths and risks should each have 2-3 items.
- verdict reflects overall quality: strong_buy (exceptional), buy (good), neutral (average), caution (below average), avoid (poor/dangerous).
- If data is insufficient (null values), note that as a risk and default to "neutral".
- Focus on: ROI, PnL, win rate, Sharpe ratio, max drawdown, number of trades, and trading style.
- This is NOT financial advice. You are providing educational analysis only.`

        const userPrompt = `Analyze this trader:\n${JSON.stringify(metrics, null, 2)}`

        const content = await callOpenAI(systemPrompt, userPrompt)

        // Parse the JSON response
        let result: AiAnalysis
        try {
          result = JSON.parse(content) as AiAnalysis
        } catch {
          logger.error('Failed to parse AI response', { content })
          throw new Error('Invalid AI response format')
        }

        // Validate the response structure
        const validVerdicts: Verdict[] = ['strong_buy', 'buy', 'neutral', 'caution', 'avoid']
        if (
          !result.summary ||
          !Array.isArray(result.strengths) ||
          !Array.isArray(result.risks) ||
          !validVerdicts.includes(result.verdict)
        ) {
          logger.error('Invalid AI response structure', { result })
          throw new Error('Invalid AI response structure')
        }

        return result
      },
      'cold', // 1-hour TTL (cold tier)
      ['ai-analyze']
    )

    return apiSuccess(analysis)
  } catch (error: unknown) {
    logger.error('AI analyze error', { error: error instanceof Error ? error.message : String(error) })
    return handleError(error, 'ai-analyze')
  }
}
