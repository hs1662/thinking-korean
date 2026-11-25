import { stripFencedCodeBlocks } from "../analyzer/stripper.mjs";

const USER_REQUEST_OPEN = "<user_request>";
const USER_REQUEST_CLOSE = "</user_request>";
const METADATA_TAGS = [
  { open: "<additional_metadata>", close: "</additional_metadata>" },
  { open: "<user_settings_change>", close: "</user_settings_change>" },
];

const QUOTE_LINE_RE = /^[ \t]*>.*$/gm;
const SHORT_ENGLISH_REQUEST_RE =
  /^(?:(?:(?:only\s+)?in\s+)?english(?:\s+only)?,?\s+please|(?:only\s+)?in\s+english(?:\s+only)?|english\s+only|영어로(?:만|도|은|는)?요?)\s*[.!]*$/i;

const FOREIGN_LANG_KO = "(?:영어|영문|프랑스어|독일어|스페인어|이탈리아어|포르투갈어|일본어|일어|일문|중국어|중문|외국어)";
const KO_RO_PARTICLE = "(?:으로|로)(?:만|도|은|는)?";
const FOREIGN_LANG_EN = "(?:english|french|german|spanish|italian|portuguese|japanese|chinese)";
const FOREIGN_LANG_TOKEN_RE = new RegExp(`(?:${FOREIGN_LANG_KO}|\\b${FOREIGN_LANG_EN}\\b|영작)`, "gi");
const LANG_CANONICAL_MAP = new Map([
  ["영어", "en"],
  ["영문", "en"],
  ["영작", "en"],
  ["english", "en"],
  ["프랑스어", "fr"],
  ["french", "fr"],
  ["독일어", "de"],
  ["german", "de"],
  ["스페인어", "es"],
  ["spanish", "es"],
  ["이탈리아어", "it"],
  ["italian", "it"],
  ["포르투갈어", "pt"],
  ["portuguese", "pt"],
  ["일본어", "ja"],
  ["일어", "ja"],
  ["일문", "ja"],
  ["japanese", "ja"],
  ["중국어", "zh"],
  ["중문", "zh"],
  ["chinese", "zh"],
  ["외국어", "foreign"],
]);

const KO_COMPLAINT_PREFIX_GUARD = "(?<!(?:왜|자꾸만?|계속(?:해서)?)(?:\\s+[가-힣]{1,8}){0,2}\\s*)";
const KO_COMPLAINT_POSTFIX_RE = /(?:왜(?!냐(?:하면|면))|자꾸만?|계속(?:해서)?)/;
const KO_STANDALONE_COMPLAINT_POSTFIX_RE = /^(?:[\s,;~]*(?:왜|자꾸만?|계속(?:해서)?)요?)+[\s,~]*\??$/;
const KO_REQUEST_NOUN_ACTION = "(?:번역|영작|작성|답변|대답|답장|응답|설명|요약|정리|출력|변환|표현|교정)";
const KO_REQUEST_NOUN_ENDING =
  "(?:해\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|주시기|주길|라|달라|보여\\s*줘요|보여\\s*줘|보여주세요)|해서\\s*(?:(?:보여|알려)\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|달라|라)|보여주세요|보여줘요|보여줘|알려주세요|알려줘요|알려줘)|해주세요|해줘요|해줘|해라|하라|하시오|하십시오|하세요(?!\\?)|하고(?=,|\\s)|하길\\s*(?:바라요|바라|바래요|바래|바랍니다)|하기\\s*(?:바라요|바라|바래요|바래|바랍니다)|하기를\\s*(?:바라요|바라|바래요|바래|바랍니다)|하길\\s*(?:원해요|원해|원합니다)|하기\\s*(?:원해요|원해|원합니다)|하기를\\s*(?:원해요|원해|원합니다)|(?:[을를]\\s*|(?<=\\s))(?:원해요|원해|원합니다|바라요|바라|바래요|바래|바랍니다)|(?:[을를]\\s*)?부탁(?:해요|해|합니다|드립니다|드려요)?|해(?=$|[.!,;\\n])|해요(?=$|[.!,;\\s])|:(?=$|\\s))";
const KO_REQUEST_VERB_CONJ =
  "(?:(?:답해|바꿔|바꾸어|옮겨|옮기어|써|적어|말해|고쳐|다시\\s*써|만들어|알려|보여)(?:\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|주길|달라|라)|(?=$|[.!,;\\n])|요(?=$|[.!,;\\s]))|(?:답하|바꾸|옮기|쓰|적|말하|고치|만들|알리|보이)(?:라|세요(?!\\?)|시오|십시오|길\\s*(?:바라요|바라|바래요|바래|바랍니다)|기\\s*(?:바라요|바라|바래요|바래|바랍니다)|기를\\s*(?:바라요|바라|바래요|바래|바랍니다)|길\\s*(?:원해요|원해|원합니다)|기\\s*(?:원해요|원해|원합니다)|기를\\s*(?:원해요|원해|원합니다))|(?:해\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|달라|라)|해주세요|해줘요|해줘|해라|부탁(?:해요|해|합니다|드립니다|드려요)?))";
const KO_SHORT_VERB_ENDING = "(?:만들어|써|적어|보여|해)\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|라|달라)|해주세요|해줘요|해줘|해라|부탁(?:해요|해|합니다|드립니다|드려요)?";

const KO_NEGATED_TRANSLATION_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:${KO_RO_PARTICLE}|만|도|은|는)?\\s*(?:(?<=\\s)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2}(?:번역|영작|작성|답변|대답|답|답장|응답|설명|요약|정리|출력|변환|교정|쓰|적|말|표현|바꾸|옮기|알려\\s*주|알리|보여\\s*주|하)(?:하|해|해서\\s*(?:보여\\s*주|알려\\s*주)|은|는|을|를)?(?:\\s*좀)?\\s*(?:지\\s*(?:말|마|않)|하지\\s*(?:말|마|않)|하면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|말고|금지|대신)` +
    `|영작(?:하|해|은|는|을|를)?(?:\\s*좀)?\\s*(?:지\\s*(?:말|마|않)|하지\\s*(?:말|마|않)|하면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|말고|금지|대신)` +
    `|${FOREIGN_LANG_KO}(?:${KO_RO_PARTICLE}|만|도|은|는)?\\s*(?:말고|대신|아닌|아니라)`,
  "g",
);

const KO_DESCRIPTIVE_OR_COMPLAINT_RE = new RegExp(
  `${FOREIGN_LANG_KO}${KO_RO_PARTICLE}\\s*(?:번역|영작|작성|답변|대답|답|답장|응답|설명|요약|정리|출력|변환|표현|옮기|옮겨|쓰|적|말|나오|생각|추론|처리|표시|생성)(?:하|해|지|졌)?(?:되어|되|된|되는|됐|했|졌|진|긴|지는|하는\\s*(?:거|것|지|데|중)|하고\\s*있|나오|았|었|잖아|는데|는지)`,
  "g",
);
const DESCRIPTIVE_MASK = " § ";

const KO_REASONING_KOREAN_RE = new RegExp(
  `(?:내부\\s*)?(?:추론|사고|생각|작업\\s*단계|단계\\s*제목|체크리스트)(?:\\s*과정)?(?:[은는을를이가도만])?\\s*(?:한국어|한글|국문)로(?:만|도|은|는)?(?:\\s*(?:(?<=\\s)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2}(?:(?:작성|유지|진행|출력|처리)\\s*${KO_REQUEST_NOUN_ENDING}|(?:해\\s*(?:줘요|줘|주세요)|해주세요|해줘요|해줘|해라|하세요(?!\\?)|하시오|하십시오|하고(?=,|\\s)|해(?=$|[.!,;\\n])|해요(?=$|[.!,;\\s])))|요?(?=$|[.!,;\\n]))`,
  "g",
);
const EN_REASONING_KOREAN_RE =
  /\b(?:keep|do|write|leave)\s+(?:(?:your|the|internal)\s+)?(?:thinking|reasoning|thoughts?|steps?|checklists?)\s+(?:in|into)\s+korean\b/gi;

const KO_KOREAN_OUTPUT_REQUEST_RE = new RegExp(
  `(?:한국어|한글|국문)로(?:만|도|은|는)?\\s*(?:(?<=\\s)(?!${FOREIGN_LANG_KO}${KO_RO_PARTICLE}\\s)(?!(?:한국어|한글|국문)로(?:만|도|은|는)?\\s)(?!왜\\s*|자꾸만?\\s*)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2}(?:(?:요약|분석|설명|작성|정리|번역|출력|답변|대답|응답)\\s*${KO_REQUEST_NOUN_ENDING}|(?:고쳐|말해|답해|답하|써|바꿔|옮겨|옮기|알려|보여)(?:\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|라|달라)|세요(?!\\?)|시오|십시오|(?=$|[.!,;\\n])|요(?=$|[.!,;\\s]))|(?:해\\s*(?:줘요|줘|주세요|주실래요|주시겠어요|주시겠습니까|주실\\s*수|줄래요|줄래|줄\\s*수|주십시오|라|달라)|해주세요|해줘요|해줘|해라|하세요(?!\\?)|하시오|하십시오|해(?=$|[.!,;\\n])|해요(?=$|[.!,;\\s])))` +
    `|(?:${KO_REQUEST_NOUN_ACTION}|번역(?:본|문)|요약(?:본|문)|초안)(?:\\s*언어)?(?:[은는도만이가]|[을를]|\\s*:)?\\s*(?:(?<=\\s)(?!(?:한국어|한글|국문)로(?:만|도|은|는)?\\s)(?!왜\\s*|자꾸만?\\s*)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2}(?:한국어|한글|국문)로(?:만|도|은|는)?(?:요?(?=$|[.!,;\\n])|\\s*${KO_REQUEST_NOUN_ENDING})`,
);

const KO_INTERMEDIATE_BLOCKLIST_RE =
  /(?:되어|되는|됐|했|하는|하고|하면|말고|대신|안\s*돼|안\s*되|버그|오류|문제|이슈|현상|원인|왜|자꾸|한국어|한글|국문)/;

const KO_SOURCE_MODIFIER_RE =
  /(?:^|\s)(?:된|작성된|작성한|번역된|번역한|쓰인|쓰여진|쓰여\s*있는|쓴|적힌|적혀\s*있는|적은|말한|답한|나온|나오는|나와\s*있는|표시된|출력된|출력한|받은|온|뜨는|뜬|찍힌|찍히는|옮겨진|옮긴|옮겼던|옮겨\s*(?:놓은|둔|준|놨던|뒀던|놓았던|두었던|주었던|줬던)|(?:되어|돼)\s*있는)(?:(?:거|것)(?:들)?(?:[을를이가은는도만]|(?:으로|로)(?:만|도|은|는)?)?|걸(?:[로도만])?|건(?:[지도만])?|게(?:[도만])?)?(?:\s|$)/;
const KO_SOURCE_OBJECT_RE =
  /(?:에러|오류|로그|메시지|문서|파일|글|코드|내용|텍스트|문단|원문|자료|기사|논문|출력|결과|주석|페이지|경고|화면|설명서)/;
const KO_CONSUME_ACTIONS = new Set(["설명", "요약", "정리"]);

const KO_LANG_RO_REQUEST_RE = new RegExp(
  `${KO_COMPLAINT_PREFIX_GUARD}(${FOREIGN_LANG_KO})${KO_RO_PARTICLE}\\s*((?:(?<=\\s)(?!${FOREIGN_LANG_KO}${KO_RO_PARTICLE}\\s)(?!왜\\s*|자꾸만?\\s*)[가-힣A-Za-z0-9,·/_-]{1,32}\\s+){0,4})(?:(${KO_REQUEST_NOUN_ACTION})(?:\\s*[을를만도은는])?(?:\\s*좀)?\\s*${KO_REQUEST_NOUN_ENDING}|${KO_REQUEST_VERB_CONJ})`,
  "g",
);

const KO_VERBLESS_RO_REQUEST_RE = new RegExp(
  `${KO_COMPLAINT_PREFIX_GUARD}(?:${KO_REQUEST_NOUN_ACTION}|번역(?:본|문)|요약(?:본|문)|초안)(?:\\s*언어)?(?:[은는도만이가]|[을를]|\\s*:)\\s*((?:(?<=\\s)(?!${FOREIGN_LANG_KO}${KO_RO_PARTICLE}\\s)(?!왜\\s*|자꾸만?\\s*)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2})(${FOREIGN_LANG_KO})${KO_RO_PARTICLE}(?:요?(?=$|[,;)])|\\s*${KO_REQUEST_NOUN_ENDING})`,
  "g",
);

const KO_NOUN_MODIFIER_REQUEST_RE = new RegExp(
  `${KO_COMPLAINT_PREFIX_GUARD}(?:(${FOREIGN_LANG_KO})\\s+(?:(?<=\\s)(?!왜\\s*|자꾸만?\\s*|계속(?:해서)?\\s*)(?![가-힣A-Za-z0-9·/_-]{0,32}[을를]\\s)[가-힣A-Za-z0-9·/_-]{1,32}\\s+){0,2}(?:번역(?:본|문)?|초안|버전|이메일|메일|문장|답장|요약본|요약문)(?:(?:을|를|만|도|은|는)?\\s*(?:(?:작성|번역|출력|제공|생성)\\s*${KO_REQUEST_NOUN_ENDING}|${KO_SHORT_VERB_ENDING})|\\s*:(?=$|\\s))` +
    `|(${FOREIGN_LANG_KO})\\s*요약(?:(?:을|를|만|도|은|는)?\\s*(?:작성|출력)\\s*${KO_REQUEST_NOUN_ENDING}|\\s*:(?=$|\\s))` +
    `|(영작)(?:\\s*[을를만도은는])?(?:\\s*좀)?\\s*${KO_REQUEST_NOUN_ENDING})`,
  "g",
);

const EN_OUTPUT_NOUNS = "(?:translation|version|draft|response|reply|summary|email|mail|message)";

const EN_NEGATED_OUTPUT_RE = new RegExp(
  `\\b(?:do\\s+not|don['’]t|never|avoid|stop|quit)\\s+(?:[a-z]+\\s+){0,2}(?:translat(?:e|ing)|writ(?:e|ing)|repl(?:y|ying)|respond(?:ing)?|answer(?:ing)?|explain(?:ing)?|summariz(?:e|ing)|output(?:ting)?|rewrit(?:e|ing)|draft(?:ing)?|speak(?:ing)?|talk(?:ing)?|us(?:e|ing))\\b[^.!?\\n,;]{0,40}\\b(?:(?:in|into|to)\\s+)?${FOREIGN_LANG_EN}\\b` +
    `|\\b(?:do\\s+not|don['’]t|never)\\s+(?:want|need)\\s+(?:(?:an?|the|some)\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b` +
    `|\\binstead\\s+of\\b[^.!?\\n,;]{0,30}\\b${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:in|into|to)\\s+${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:an?\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b`,
  "gi",
);

const EN_NARRATIVE_COMPLAINT_RE =
  /\b(?:kept|keeps|tried|trying|continues?|continued|started|began|seems?\s+to|tends?\s+to|why\s+(?:did|do|does|is|are|was|were))\b/i;

const EN_ACTION_BODY =
  `(?:translate\\b[^.!?\\n]{0,60}\\b(?:into|to)\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:write|reply|respond|answer|explain|summarize|output|rewrite|draft|compose|phrase|express|say|give|provide|return|produce)\\b[^.!?\\n]{0,50}\\bin\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:give|provide|write|draft|compose|output|return|produce|show|make)\\b[^.!?\\n]{0,40}\\b(?:an?\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b)`;

const EN_IMPERATIVE_REQUEST_RE = new RegExp(
  `(?:^|(?:[,;]\\s*|\\b(?:and|then|so)\\s+))(?:(?:please|kindly|just|now|only|always)\\s+)*${EN_ACTION_BODY}`,
  "gi",
);

const EN_POLITE_REQUEST_RE = new RegExp(
  `\\b(?:can\\s+you|could\\s+you|would\\s+you|will\\s+you|please|i\\s+(?:want|need|would\\s+like)(?:\\s+you)?\\s+to|i['’]d\\s+like(?:\\s+you)?\\s+to)\\s+(?:(?:please|kindly|just)\\s+){0,3}${EN_ACTION_BODY}` +
    `|\\b(?:i\\s+(?:want|need|would\\s+like)|i['’]d\\s+like)\\s+(?:(?:an?|the|some)\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b`,
  "gi",
);

const EN_DIRECT_TRANSLATION_NOUN_RE = new RegExp(
  `^\\s*(?:please\\s+)?(?:an?\\s+)?${FOREIGN_LANG_EN}\\s+translation(?:\\s+(?:please|only))?\\s*[:.]?$`,
  "gi",
);

const EN_KOREAN_OUTPUT_REQUEST_RE =
  /\b(?:reply|respond|answer|write|explain|summarize|translate|output|speak|talk)\b[^.!?\n]{0,40}\b(?:in|into|to)\s+korean\b/i;

const INTERNAL_DOT_RE = /(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])/g;

function extractLanguageCodes(text) {
  const langs = new Set();
  for (const match of text.matchAll(FOREIGN_LANG_TOKEN_RE)) {
    const code = LANG_CANONICAL_MAP.get(match[0].toLowerCase());
    if (code) {
      langs.add(code);
    }
  }
  return langs;
}

function unwrapUserRequest(stripped) {
  const lower = stripped.toLowerCase();
  if (!lower.startsWith(USER_REQUEST_OPEN)) {
    return stripped;
  }
  const closeIdx = lower.lastIndexOf(USER_REQUEST_CLOSE);
  if (closeIdx >= USER_REQUEST_OPEN.length) {
    return stripped.slice(USER_REQUEST_OPEN.length, closeIdx).trim();
  }
  return stripped;
}

function stripMetadataBlocks(text) {
  const lower = text.toLowerCase();
  const activeTags = [];
  for (const tag of METADATA_TAGS) {
    const openIdx = lower.indexOf(tag.open);
    if (openIdx !== -1 && lower.indexOf(tag.close, openIdx + tag.open.length) !== -1) {
      activeTags.push({ tag, openIdx });
    }
  }
  if (activeTags.length === 0) {
    return text;
  }

  let cursor = 0;
  let result = "";

  while (cursor < text.length) {
    let bestEntry = null;

    for (const entry of activeTags) {
      if (entry.openIdx === -1) {
        continue;
      }
      if (entry.openIdx < cursor) {
        entry.openIdx = lower.indexOf(entry.tag.open, cursor);
        if (entry.openIdx === -1) {
          continue;
        }
      }
      if (bestEntry === null || entry.openIdx < bestEntry.openIdx) {
        bestEntry = entry;
      }
    }

    if (bestEntry === null) {
      break;
    }

    const { tag, openIdx } = bestEntry;
    const closeIdx = lower.indexOf(tag.close, openIdx + tag.open.length);
    if (closeIdx === -1) {
      bestEntry.openIdx = -1;
      continue;
    }

    result += text.slice(cursor, openIdx);
    cursor = closeIdx + tag.close.length;
  }

  return cursor === 0 ? text : result + text.slice(cursor);
}

function extractUserRequestBody(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }
  const stripped = stripMetadataBlocks(rawText.replace(/\r\n?/g, "\n")).trim();
  return stripFencedCodeBlocks(unwrapUserRequest(stripped)).replace(QUOTE_LINE_RE, "").trim();
}

function isSourceDescription(intermediate, action) {
  if (!KO_SOURCE_MODIFIER_RE.test(intermediate)) {
    return false;
  }
  const trimmed = intermediate.trimEnd();
  const withoutJom = (trimmed.endsWith("좀") ? trimmed.slice(0, -1) : trimmed).trim();
  const resolvedAction =
    action ||
    (withoutJom
      .split(/\s+/)
      .pop() ?? ""
    ).replace(/[을를]$/, "");
  return KO_SOURCE_OBJECT_RE.test(intermediate) || KO_CONSUME_ACTIONS.has(resolvedAction);
}

function hasComplaintPostfix(text, match, nextSentence = "") {
  const remainder = text.slice((match.index ?? 0) + match[0].length);
  if (KO_COMPLAINT_POSTFIX_RE.test(remainder)) {
    return true;
  }
  return /^요?[\s,;~]*\??$/.test(remainder) && KO_STANDALONE_COMPLAINT_POSTFIX_RE.test(nextSentence);
}

function collectKoreanEnglishRequestLangs(sentence, nextSentence = "") {
  const langs = new Set();
  if (KO_KOREAN_OUTPUT_REQUEST_RE.test(sentence)) {
    return langs;
  }
  const masked = sentence.replace(KO_DESCRIPTIVE_OR_COMPLAINT_RE, DESCRIPTIVE_MASK);

  for (const match of masked.matchAll(KO_LANG_RO_REQUEST_RE)) {
    if (hasComplaintPostfix(masked, match, nextSentence)) {
      continue;
    }
    const intermediate = (match[2] ?? "").trim();
    if (intermediate.length === 0 || (!KO_INTERMEDIATE_BLOCKLIST_RE.test(intermediate) && !isSourceDescription(intermediate, match[3] ?? ""))) {
      const code = LANG_CANONICAL_MAP.get((match[1] ?? "").toLowerCase());
      if (code) {
        langs.add(code);
      }
    }
  }

  for (const match of masked.matchAll(KO_VERBLESS_RO_REQUEST_RE)) {
    if (hasComplaintPostfix(masked, match, nextSentence)) {
      continue;
    }
    const intermediate = (match[1] ?? "").trim();
    if (intermediate.length === 0 || (!KO_INTERMEDIATE_BLOCKLIST_RE.test(intermediate) && !KO_SOURCE_MODIFIER_RE.test(intermediate))) {
      const code = LANG_CANONICAL_MAP.get((match[2] ?? "").toLowerCase());
      if (code) {
        langs.add(code);
      }
    }
  }

  for (const match of masked.matchAll(KO_NOUN_MODIFIER_REQUEST_RE)) {
    if (hasComplaintPostfix(masked, match, nextSentence)) {
      continue;
    }
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const code = LANG_CANONICAL_MAP.get(token.toLowerCase());
    if (code) {
      langs.add(code);
    }
  }

  return langs;
}

function collectEnglishRequestClauseLangs(clause) {
  const langs = new Set();
  if (EN_NARRATIVE_COMPLAINT_RE.test(clause)) {
    return langs;
  }
  for (const re of [EN_IMPERATIVE_REQUEST_RE, EN_POLITE_REQUEST_RE, EN_DIRECT_TRANSLATION_NOUN_RE]) {
    for (const match of clause.matchAll(re)) {
      for (const code of extractLanguageCodes(match[0])) {
        langs.add(code);
      }
    }
  }
  return langs;
}

function collectEnglishRequestLangs(sentence) {
  const direct = collectEnglishRequestClauseLangs(sentence);
  if (direct.size > 0) {
    return direct;
  }
  const clauses = sentence
    .split(/(?:,\s*(?:so|but|and)\s+|;\s*|\b(?:so|but)\s+)/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (clauses.length <= 1) {
    return direct;
  }
  const combined = new Set();
  for (const clause of clauses) {
    for (const code of collectEnglishRequestClauseLangs(clause)) {
      combined.add(code);
    }
  }
  return combined;
}

function stripNegatedClausesAndCollectLangs(text) {
  const negatedLangs = new Set();
  const maskNegation = (match) => {
    for (const code of extractLanguageCodes(match)) {
      negatedLangs.add(code);
    }
    return DESCRIPTIVE_MASK;
  };
  const unnegated = text
    .replace(KO_NEGATED_TRANSLATION_RE, maskNegation)
    .replace(EN_NEGATED_OUTPUT_RE, maskNegation);
  return { unnegated, negatedLangs };
}

const TRAILING_QUESTION_PUNCT_RE = /[\s,;.!…~?]/;

function collapseTrailingQuestionPunctuation(text) {
  if (!text.endsWith("?")) {
    return text;
  }
  let end = text.length;
  while (end > 0 && TRAILING_QUESTION_PUNCT_RE.test(text[end - 1])) {
    end -= 1;
  }
  return `${text.slice(0, end)}?`;
}

export function isExplicitEnglishOutputRequest(rawText) {
  const body = extractUserRequestBody(rawText);
  if (body.length === 0) {
    return false;
  }
  if (SHORT_ENGLISH_REQUEST_RE.test(body)) {
    return true;
  }

  const normalizedBody = body
    .replace(/？/g, "?")
    .replace(INTERNAL_DOT_RE, "·")
    .replace(KO_REASONING_KOREAN_RE, DESCRIPTIVE_MASK)
    .replace(EN_REASONING_KOREAN_RE, DESCRIPTIVE_MASK);
  const { unnegated, negatedLangs } = stripNegatedClausesAndCollectLangs(normalizedBody);

  const sentences = [];
  for (const rawPart of unnegated.split(/(?<=\?)(?!\?)[.!…\n]*|[.!…\n]+/)) {
    const trimmed = rawPart.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = collapseTrailingQuestionPunctuation(trimmed);
    if (normalized === "?") {
      if (sentences.length > 0 && !sentences[sentences.length - 1].endsWith("?")) {
        sentences[sentences.length - 1] = collapseTrailingQuestionPunctuation(`${sentences[sentences.length - 1]}?`);
      }
      continue;
    }
    sentences.push(normalized);
  }
  const requestedLangs = new Set();
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    const nextSentence = sentences[i + 1] ?? "";
    for (const code of collectKoreanEnglishRequestLangs(sentence, nextSentence)) {
      requestedLangs.add(code);
    }
    for (const code of collectEnglishRequestLangs(sentence)) {
      requestedLangs.add(code);
    }
  }

  if (negatedLangs.has("foreign")) {
    return false;
  }
  const activeRequestedLangs = [...requestedLangs].filter((code) => !negatedLangs.has(code));
  if (activeRequestedLangs.length === 0) {
    return false;
  }

  return !sentences.some(
    (sentence) => KO_KOREAN_OUTPUT_REQUEST_RE.test(sentence) || EN_KOREAN_OUTPUT_REQUEST_RE.test(sentence),
  );
}
