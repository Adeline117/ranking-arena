export type ClearTranslationSourceLanguage = 'en' | 'ja' | 'ko'

const HAN_RE = /\p{Script=Han}/u
const HIRAGANA_RE = /\p{Script=Hiragana}/u
const KATAKANA_RE = /\p{Script=Katakana}/u
const HANGUL_RE = /\p{Script=Hangul}/u
const LATIN_RE = /\p{Script=Latin}/u

/**
 * Detect only source languages that are safe to short-circuit locally.
 *
 * A majority vote is not enough: `Trading 거래` still contains text that must
 * be translated for an English viewer. Any supported foreign script therefore
 * makes the result ambiguous and delegates detection to the provider. Han-only
 * text is also ambiguous because Chinese and Japanese share those characters.
 */
export function detectClearTranslationSourceLanguage(
  text: string
): ClearTranslationSourceLanguage | null {
  let han = 0
  let kana = 0
  let hangul = 0
  let latin = 0

  for (const character of text) {
    if (HIRAGANA_RE.test(character) || KATAKANA_RE.test(character)) kana += 1
    else if (HANGUL_RE.test(character)) hangul += 1
    else if (HAN_RE.test(character)) han += 1
    else if (LATIN_RE.test(character)) latin += 1
  }

  if (latin > 0 && han === 0 && kana === 0 && hangul === 0) return 'en'
  if (hangul > 0 && han === 0 && kana === 0 && latin === 0) return 'ko'
  if (kana > 0 && hangul === 0 && latin === 0) return 'ja'
  return null
}
