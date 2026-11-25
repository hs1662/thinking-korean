// Public thresholds (re-exported by scripts/analyzer.mjs).
export const MIN_NATURAL_CHARS = 24;
export const MIN_HANGUL_RATIO = 0.45;
export const MIN_LATIN_CHARS_FOR_DRIFT = 16;
export const ENGLISH_RUN_WORD_THRESHOLD = 8;
export const SEGMENT_MIN_NATURAL_CHARS = 32;
export const SEGMENT_MAX_HANGUL_RATIO = 0.25;
export const SHORT_ENGLISH_PROSE_WORD_THRESHOLD = 4;

// Internal thresholds.
export const MAX_SHORT_TOKEN_QUOTE_CHARS = 60;
export const MAX_SHORT_TOKEN_QUOTE_WORDS = 4;
export const MAX_ERROR_QUOTE_CHARS = 180;
export const MAX_STRUCTURED_HEADING_CHARS = 100;
export const MAX_CITED_TITLE_CHARS = 90;
export const MAX_CITED_TITLE_WORDS = 10;
export const SHORT_ENGLISH_PROSE_MAX_HANGUL = 2;
export const SHORT_ENGLISH_PROSE_MAX_HANGUL_RATIO = 0.15;
export const KOREAN_LINE_MIN_HANGUL = 6;
export const KOREAN_LINE_MIN_TOKENS = 2;
export const MAX_EMBEDDED_TERM_WORDS = 3;
export const PROSE_FALLBACK_MIN_HANGUL = 12;
export const UI_MIN_LATIN_CHARS_FOR_DRIFT = 8;
// UI labels: a Korean-free label of at most this many words made only of
// Title Case names, acronyms, numbers and versions is treated as a proper name.
export const UI_MAX_PROPER_NAME_WORDS = 4;
