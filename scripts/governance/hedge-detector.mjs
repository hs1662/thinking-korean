import { extractNaturalText } from "../analyzer/stripper.mjs";

const HEDGE_CUES = [
  "아마",
  "추정",
  "일 것 같",
  "할 것 같",
  "일반적으로",
  "가능성이 있",
  "작동할 것",
  "무방할 것",
  "보입니다",
];

const HEDGE_RE = new RegExp(HEDGE_CUES.join("|"), "g");

export function detectHedges(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { hedgeHits: 0, matches: [] };
  }
  const naturalText = extractNaturalText(text);
  if (naturalText.length === 0) {
    return { hedgeHits: 0, matches: [] };
  }
  const matches = naturalText.match(HEDGE_RE) ?? [];
  return {
    hedgeHits: matches.length,
    matches,
  };
}
