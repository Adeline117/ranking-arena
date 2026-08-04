/** Shared browser/server translation admission limits. Keep this module dependency-free. */
export const TRANSLATION_MAX_BATCH_ITEMS = 20
export const TRANSLATION_MAX_TEXT_LENGTH = 50_000
export const TRANSLATION_MAX_BATCH_TEXT_LENGTH = 200_000
export const TRANSLATION_MAX_OUTPUT_TEXT_LENGTH = TRANSLATION_MAX_TEXT_LENGTH * 4
