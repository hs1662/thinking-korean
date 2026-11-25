// Shared English lexicon (single bitmask dictionary) and common regexes.

export const STOP = 1; // stopwords, matched only as ALL-CAPS tokens
export const FUNCTION = 2; // English prose function words
export const FINITE = 4; // finite verbs that mark an English sentence
export const IMPERATIVE = 8; // imperative verbs that open command-like labels

const WORDS_BY_FLAG = [
  [
    STOP,
    "about after all also an and any are as at be been before but by can check could did do does done " +
      "each else first for from go has have he hello here how if in into is it just last let may me more " +
      "must my next no not now of on only or our over please see should so some sorry stop thank that the " +
      "them then they this to up us very wait was we were what when who why will with would you your",
  ],
  [
    FUNCTION,
    "i me you we they them he him she her his it its this that these those my your our their am is are " +
      "was were be been being will would shall should can could may might must do does did have has had " +
      "not the a an let please because although however therefore while before after then since unless " +
      "until if when where why how what who here there now so but wait okay ok sorry thank thanks and or " +
      "in on at to of for from with by as into all about over under between through without",
  ],
  [
    FINITE,
    "i we you they he she am is are was were has have had will would should could can must did does " +
      "also now here there because therefore however",
  ],
  [
    IMPERATIVE,
    "check fix analyze run update create delete remove add build test verify validate inspect review " +
      "audit refactor migrate implement deploy install configure setup merge rebase push pull fetch read " +
      "write edit search find list show open close start stop restart debug trace profile benchmark clean " +
      "format lint typecheck compile bundle parse extract split move rename copy sync load save export " +
      "import prepare plan design investigate explore summarize explain document report collect gather " +
      "compare resolve handle support enable disable toggle switch select choose confirm approve reject " +
      "deny allow block retry recover restore rollback reset init initialize generate scaffold render " +
      "display print log monitor watch poll wait schedule trigger dispatch invoke execute call send post " +
      "submit publish release ship finalize complete finish apply patch revert stash stage commit tag",
  ],
];

const LEXICON = new Map();
for (const [flag, list] of WORDS_BY_FLAG) {
  for (const word of list.split(" ")) {
    LEXICON.set(word, (LEXICON.get(word) ?? 0) | flag);
  }
}

// Exact-key lookup on the lowercase dictionary (callers normalize case themselves).
export function hasWordFlag(word, flag) {
  return ((LEXICON.get(word) ?? 0) & flag) !== 0;
}

// Only ALL-CAPS spellings of a STOP word are members.
export function isUpperStopword(word) {
  return word === word.toUpperCase() && hasWordFlag(word.toLowerCase(), STOP);
}

export const HANGUL_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/g;
export const HANGUL_TOKEN_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/g;
export const HAS_HANGUL_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/;
export const LATIN_RE = /[A-Za-z]/g;
export const ENGLISH_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
export const EMBEDDED_LATIN_SPAN_RE =
  /[A-Za-z]+(?:['’-][A-Za-z]+)*(?:(?:[ \t]+|[.!?][ \t]+|,[ \t]*)[A-Za-z]+(?:['’-][A-Za-z]+)*)*/g;
export const ENGLISH_CONTRACTION_RE = /(?:n['’]t|['’](?:m|re|ve|ll|d))$/i;
export const PROSE_TOKEN_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+|[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
export const SENTENCE_BOUNDARY_RE = /[A-Za-z]{2,}[.!?][ \t]+[A-Za-z]/;
export const PROSE_OPENER_RE =
  /^(?:i\s+(?:will|would|should|need|can|could|have|had|am|was|think|believe|see|found|checked|want|try)|i['’](?:ll|m|ve|d)\b|let\s+me\b|let['’]s\b|we\s+(?:need|should|can|will|must|have)\b|you\s+(?:can|should|need|will|must|may)\b|now\s+(?:i|let|we|the)\b|wait\b|okay\b|ok\b|sure\b|sorry\b|please\b|thank\b|here\s+(?:is|are)\b|this\s+(?:is|was|will|means|shows|looks)\b|that\s+(?:is|was|will|means)\b|it\s+(?:is|was|will|seems|looks)\b|there\s+(?:is|are|was|were)\b|the\s+(?:user|agent|model|system|file|code|error|issue|bug|previous|next|first|second)\b|(?:could|would|should|did|does|do|will|may|might)\s+not\b|(?:can|don|won|didn|doesn|couldn|wouldn|shouldn)['’]t\b|cannot\b|failed\s+to\b|unable\s+to\b)/i;

export function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

export function countEnglishWords(text) {
  return countMatches(text, ENGLISH_WORD_RE);
}

export function englishWords(text) {
  return text.match(ENGLISH_WORD_RE) ?? [];
}

export function measureLanguage(text) {
  const hangulCount = countMatches(text, HANGUL_RE);
  const latinCount = countMatches(text, LATIN_RE);
  const naturalCharCount = hangulCount + latinCount;
  const hangulRatio = naturalCharCount > 0 ? hangulCount / naturalCharCount : 0;
  return { hangulCount, latinCount, naturalCharCount, hangulRatio };
}

export function hasEnglishSentenceFiniteWord(words) {
  return words.some((word) => ENGLISH_CONTRACTION_RE.test(word) || hasWordFlag(word.toLowerCase(), FINITE));
}

export function hasEnglishProseFunctionWord(words) {
  return words.some((word) => {
    if (ENGLISH_CONTRACTION_RE.test(word)) {
      return true;
    }
    return word
      .toLowerCase()
      .split(/['’]/)
      .some((part) => hasWordFlag(part, FUNCTION));
  });
}
