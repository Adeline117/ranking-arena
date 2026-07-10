/**
 * Pluralization helper for trader-count labels.
 *
 * `${count} ${t('traders')}` always renders the plural form, so a count of 1
 * shows "1 traders" (U1-15). This picks the singular key when count === 1.
 *
 * CJK languages have no singular/plural distinction, so their singular keys
 * mirror the plural value — only English actually changes.
 */
export function traderCountLabel(count: number, t: (key: string) => string): string {
  return count === 1 ? t('traderSingular') : t('traders')
}
