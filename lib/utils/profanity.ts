/**
 * Basic profanity filter for trader display names.
 * Replaces offensive words with asterisks while keeping the rest readable.
 */

const PROFANITY_LIST = [
  'fuck',
  'shit',
  'ass',
  'bitch',
  'dick',
  'cock',
  'pussy',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'whore',
  'slut',
]

// Build regex: match whole words or as substrings, case-insensitive.
// `g` flag is needed by .replace() (replace ALL). For .test() we use a
// SEPARATE non-global regex — a `g`-flagged regex's .test() is stateful
// (advances lastIndex), so containsProfanity('x') would alternate true/false
// across calls. Non-global .test() is stateless. (bug fixed 2026-07-03)
const PROFANITY_PATTERN = `\\b(${PROFANITY_LIST.join('|')})\\b`
const PROFANITY_REGEX = new RegExp(PROFANITY_PATTERN, 'gi')
const PROFANITY_TEST_REGEX = new RegExp(PROFANITY_PATTERN, 'i')

// Placeholder/default names from exchanges that should be treated as "no name set"
const PLACEHOLDER_NAMES = new Set([
  'enter name',
  'enter your name',
  'your name',
  'unnamed',
  'untitled',
  'no name',
  'noname',
  'default',
  'test',
  'user',
  'trader',
  'name',
  'nickname',
  'display name',
  'set nickname',
  '请输入昵称',
  '未设置',
  '设置昵称',
  '请输入',
  '昵称',
])

/**
 * Sanitize a display name by replacing profanity with asterisks
 * and stripping placeholder/default names.
 * Returns empty string for placeholder names (caller should fall back to address).
 */
export function sanitizeDisplayName(name: string | null | undefined): string {
  if (!name) return ''
  // Strip placeholder names — return empty so caller uses wallet address
  if (PLACEHOLDER_NAMES.has(name.trim().toLowerCase())) return ''
  return name.replace(PROFANITY_REGEX, (match) => {
    if (match.length <= 2) return '*'.repeat(match.length)
    return match[0] + '*'.repeat(match.length - 2) + match[match.length - 1]
  })
}

/**
 * Check if a name contains profanity.
 */
export function containsProfanity(name: string): boolean {
  // Non-global regex → .test() is stateless (see PROFANITY_TEST_REGEX note)
  return PROFANITY_TEST_REGEX.test(name)
}
