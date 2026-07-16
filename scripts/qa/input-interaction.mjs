const TEXT_INPUT_PROBES = new Map([
  ['', 'qa-probe'],
  ['text', 'qa-probe'],
  ['search', 'qa-probe'],
  ['tel', '5550100'],
  ['password', 'qa-probe'],
  ['email', 'qa-probe@example.invalid'],
  ['url', 'https://example.invalid/'],
  ['number', '1'],
])

export function fillProbeFor({ tag, type = '' }) {
  const normalizedTag = String(tag).toLowerCase()
  if (normalizedTag === 'textarea') return 'qa-probe'
  if (normalizedTag !== 'input') return null
  return TEXT_INPUT_PROBES.get(String(type).toLowerCase()) ?? null
}

function summarizeFillError(error) {
  return String(error instanceof Error ? error.message : error)
    .split('\n')
    .find(Boolean)
    ?.slice(0, 300)
}

export async function exerciseFill(locator, descriptor) {
  const probe = fillProbeFor(descriptor)
  if (probe === null) return { handled: false }

  try {
    await locator.fill(probe)
    await locator.press('Escape').catch(() => {})
    return { handled: true, ok: true }
  } catch (error) {
    return {
      handled: true,
      ok: false,
      error: summarizeFillError(error) || 'unknown fill error',
    }
  }
}
