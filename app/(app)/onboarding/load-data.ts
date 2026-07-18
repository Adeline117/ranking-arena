import type { Group, Trader } from './components/types'

type OnboardingFetch = (input: string) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isTrader(value: unknown): value is Trader {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.source_trader_id === 'string' &&
    isNullableString(value.handle) &&
    isNullableString(value.avatar_url) &&
    isNullableNumber(value.roi) &&
    isNullableNumber(value.arena_score)
  )
}

function isGroup(value: unknown): value is Group {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isNullableString(value.name_en) &&
    isNullableString(value.description) &&
    isNullableString(value.avatar_url) &&
    isNullableNumber(value.member_count)
  )
}

async function readPayload(
  response: Pick<Response, 'json' | 'ok' | 'status'>,
  resource: string
): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null)
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`Onboarding ${resource} request failed with status ${response.status}`)
  }
  return payload
}

export async function loadOnboardingTraders(fetcher: OnboardingFetch = fetch): Promise<Trader[]> {
  const response = await fetcher('/api/sidebar/top-traders')
  const payload = await readPayload(response, 'traders')
  if (!Array.isArray(payload.traders) || !payload.traders.every(isTrader)) {
    throw new Error('Onboarding traders response is malformed')
  }
  return payload.traders
}

export async function loadOnboardingGroups(fetcher: OnboardingFetch = fetch): Promise<Group[]> {
  const response = await fetcher('/api/groups?limit=8&sort_by=member_count')
  const payload = await readPayload(response, 'groups')
  const data = payload.data
  if (
    payload.success !== true ||
    !isRecord(data) ||
    !Array.isArray(data.groups) ||
    !data.groups.every(isGroup)
  ) {
    throw new Error('Onboarding groups response is malformed')
  }
  return data.groups
}
