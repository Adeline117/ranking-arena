/**
 * Basic profanity filter for trader display names.
 * Replaces offensive words with asterisks while keeping the rest readable.
 */

const PROFANITY_LIST = [
  'fuck', 'shit', 'ass', 'bitch', 'dick', 'cock', 'pussy', 'cunt',
  'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
]

// Build regex: match whole words or as substrings, case-insensitive
const PROFANITY_REGEX = new RegExp(
  `\\b(${PROFANITY_LIST.join('|')})\\b`,
  'gi'
)

/**
 * Sanitize a display name by replacing profanity with asterisks.
 * Preserves the first and last character of the matched word for context.
 * e.g. "fuck" → "f**k"
 */
export function sanitizeDisplayName(name: string | null | undefined): string {
  if (!name) return ''
  return name.replace(PROFANITY_REGEX, (match) => {
    if (match.length <= 2) return '*'.repeat(match.length)
    return match[0] + '*'.repeat(match.length - 2) + match[match.length - 1]
  })
}

/**
 * Check if a name contains profanity.
 */
export function containsProfanity(name: string): boolean {
  return PROFANITY_REGEX.test(name)
}
