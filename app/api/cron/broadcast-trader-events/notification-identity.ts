export function traderEventLink(traderId: string, source: string): string {
  const path = `/trader/${encodeURIComponent(traderId)}`
  return source ? `${path}?platform=${encodeURIComponent(source)}` : path
}

export function traderEventReference(
  traderId: string,
  source: string,
  kind: 'metric' | 'position',
  eventDate: string
): string {
  return [
    'trader_event',
    encodeURIComponent(source),
    encodeURIComponent(traderId),
    kind,
    eventDate,
  ].join(':')
}
