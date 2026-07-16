const HARD_STATUS_PREFIXES = [
  'fail:',
  'dead:no-effect',
  'pagehealth:blank',
  'pagehealth:not-found',
  'i18n-leak:',
]

const APP_ERROR_PREFIXES = ['pageerror:', 'console:', 'http:']

export function hardSweepReasons(record) {
  const reasons = []
  const status = String(record?.status || '')

  if (HARD_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix))) {
    reasons.push(`status:${status}`)
  }

  for (const error of Array.isArray(record?.errors) ? record.errors : []) {
    const message = String(error)
    if (APP_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) {
      reasons.push(message)
    }
  }

  return [...new Set(reasons)]
}

export function hardSweepFindings(ledger) {
  return ledger.flatMap((record) => {
    const reasons = hardSweepReasons(record)
    return reasons.length ? [{ record, reasons }] : []
  })
}
