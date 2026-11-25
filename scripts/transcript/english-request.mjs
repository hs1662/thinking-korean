import { stripFencedCodeBlocks } from "../analyzer/stripper.mjs";

const USER_REQUEST_OPEN = "<user_request>";
const USER_REQUEST_CLOSE = "</user_request>";
const METADATA_BLOCK_RE =
  /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/gi;

const QUOTE_LINE_RE = /^[ \t]*>.*$/gm;
const SHORT_ENGLISH_REQUEST_RE = /^(?:(?:in\s+)?english,?\s+please|in\s+english|영어로요?)\s*[.!]*$/i;

const FOREIGN_LANG_KO = "(?:영어|영문|프랑스어|독일어|스페인어|이탈리아어|포르투갈어|외국어)";
const FOREIGN_LANG_EN = "(?:english|french|german|spanish|italian|portuguese)";

const KO_REQUEST_NOUN_ACTION = "(?:번역|영작|작성|답변|답장|응답|설명|요약|정리|출력|변환|표현|교정)";
const KO_REQUEST_NOUN_ENDING =
  "(?:해\\s*(?:줘|줘요|주세요|주실래요|주실\\s*수|줄래|줄래요|줄\\s*수|주십시오|주시기|주길|라|달라|보여\\s*줘|보여주세요)|해주세요|해줘|해라|하라|하시오|하십시오|하세요|하길\\s*바라|하기\\s*바라|하기를\\s*바라|하길\\s*원해|하기\\s*원해|하기를\\s*원해|(?:[을를]\\s*|\\s+)(?:원해|원해요|원합니다|바라|바래|바랍니다)|(?:[을를]\\s*|\\s*)부탁(?:해|해요|합니다|드립니다|드려요)?|해(?=$|[.!?,])|해요(?=$|[.!?,\\s])|\\s*:(?=$|\\s))";
const KO_REQUEST_VERB_CONJ =
  "(?:(?:답해|바꿔|바꾸어|옮겨|옮기어|써|적어|말해|고쳐|다시\\s*써|만들어)(?:\\s*(?:줘|줘요|주세요|주실래요|줄래|줄래요|주십시오|주길|달라|라)|(?=$|[.!?,])|요(?=$|[.!?,\\s]))|(?:답하|바꾸|옮기|쓰|적|말하|고치|만들)(?:라|세요|시오|십시오|길\\s*바라|기\\s*바라|기를\\s*바라|길\\s*원해|기\\s*원해|기를\\s*원해)|(?:해\\s*(?:줘|줘요|주세요|주실래요|줄래|줄래요|주십시오|달라|라)|해주세요|해줘|해라|부탁(?:해|해요|합니다|드립니다|드려요)?))";
const KO_SHORT_VERB_ENDING = "(?:만들어|써|적어|보여|해)\\s*(?:줘|줘요|주세요|줄래|라|달라)|해주세요|해줘|해라|부탁(?:해|해요|합니다|드립니다|드려요)?";

const KO_NEGATED_TRANSLATION_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)?\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:번역|영작|작성|답변|답|답장|응답|설명|요약|정리|출력|변환|쓰|적|말|표현|바꾸|옮기|하)(?:하|해|은|는|을|를)?(?:\\s*좀)?\\s*(?:지\\s*(?:말|마|않)|하지\\s*(?:말|마|않)|하면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|말고|금지|대신)` +
    `|영작(?:하|해|은|는|을|를)?(?:\\s*좀)?\\s*(?:지\\s*(?:말|마|않)|하지\\s*(?:말|마|않)|하면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|말고|금지|대신)` +
    `|${FOREIGN_LANG_KO}(?:으로|로)?\\s*(?:말고|대신|아닌|아니라)`,
);

const KO_DESCRIPTIVE_OR_COMPLAINT_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)\\s*(?:번역|영작|작성|답변|답|답장|응답|설명|요약|정리|출력|변환|표현|옮기|옮겨|쓰|적|말|나오|생각|추론|처리|표시|생성)(?:하|해|지|졌)?(?:되어|되|된|되는|됐|했|졌|진|긴|지는|하는\\s*(?:거|것|지|데|중)|하고\\s*있|나오|았|었|잖아|는데|는지)`,
  "g",
);
const DESCRIPTIVE_MASK = " § ";

const KO_KOREAN_OUTPUT_REQUEST_RE = new RegExp(
  `(?:한국어|한글|국문)로\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:(?:요약|분석|설명|작성|정리|번역|출력|답변|응답)${KO_REQUEST_NOUN_ENDING}|(?:고쳐|말해|답해|답하|써|바꿔|옮겨|옮기)(?:\\s*(?:줘|줘요|주세요|주실래요|줄래|줄래요|주십시오|라|달라)|세요|시오|십시오|(?=$|[.!?,])|요(?=$|[.!?,\\s]))|(?:해\\s*(?:줘|줘요|주세요)|해주세요|해줘|해라))`,
);

const KO_INTERMEDIATE_BLOCKLIST_RE =
  /(?:되어|되는|됐|했|하는|하고|하면|말고|대신|안\s*돼|안\s*되|버그|오류|문제|이슈|현상|원인|한국어|한글|국문)/;

const KO_SOURCE_MODIFIER_RE =
  /(?:^|\s)(?:된|작성된|쓰인|쓰여진|적힌|나온|표시된|출력된|옮겨진|옮긴|옮겨\s*놓은|옮겨\s*둔|되어\s*있는)(?:\s|$)/;
const KO_SOURCE_OBJECT_RE =
  /(?:에러|오류|로그|메시지|문서|파일|글|코드|내용|텍스트|문단|원문|자료|기사|논문|출력|결과|주석|페이지|경고|화면|설명서)/;
const KO_CONSUME_ACTIONS = new Set(["설명", "요약", "정리"]);

const KO_LANG_RO_REQUEST_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)\\s*((?:(?!${FOREIGN_LANG_KO}(?:으로|로)\\s)[가-힣A-Za-z0-9,·-]+\\s+){0,4})(?:(${KO_REQUEST_NOUN_ACTION})${KO_REQUEST_NOUN_ENDING}|${KO_REQUEST_VERB_CONJ})`,
  "g",
);

const KO_NOUN_MODIFIER_REQUEST_RE = new RegExp(
  `(?:영어|영문)\\s+(?:(?![가-힣A-Za-z0-9]*[을를]\\s)[가-힣A-Za-z0-9]+\\s+){0,2}(?:번역(?:본|문)?|초안|버전|이메일|메일|문장|답장|요약본|요약문)(?:(?:을|를)?\\s*(?:(?:작성|번역|출력|제공|생성)${KO_REQUEST_NOUN_ENDING}|${KO_SHORT_VERB_ENDING})|\\s*:(?=$|\\s))` +
    `|(?:영어|영문)\\s*요약(?:(?:을|를)?\\s*(?:작성|출력)${KO_REQUEST_NOUN_ENDING}|\\s*:(?=$|\\s))` +
    `|영작(?:\\s*[을를])?(?:\\s*좀)?\\s*${KO_REQUEST_NOUN_ENDING}`,
);

const EN_OUTPUT_NOUNS = "(?:translation|version|draft|response|reply|summary|email|mail|message)";

const EN_NEGATED_OUTPUT_RE = new RegExp(
  `\\b(?:do\\s+not|don['’]t|never|avoid|stop|quit)\\s+(?:[a-z]+\\s+){0,2}(?:translat(?:e|ing)|writ(?:e|ing)|repl(?:y|ying)|respond(?:ing)?|answer(?:ing)?|explain(?:ing)?|summariz(?:e|ing)|output(?:ting)?|rewrit(?:e|ing)|draft(?:ing)?|speak(?:ing)?|talk(?:ing)?|us(?:e|ing))\\b[^.!?\\n,;]{0,40}\\b(?:(?:in|into|to)\\s+)?${FOREIGN_LANG_EN}\\b` +
    `|\\b(?:do\\s+not|don['’]t|never)\\s+(?:want|need)\\s+(?:(?:an?|the|some)\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b` +
    `|\\binstead\\s+of\\b[^.!?\\n,;]{0,30}\\b${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:in|into|to)\\s+${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:an?\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b`,
  "i",
);

const EN_NARRATIVE_COMPLAINT_RE =
  /\b(?:kept|keeps|tried|trying|continues?|continued|started|began|seems?\s+to|tends?\s+to|why\s+(?:did|do|does|is|are|was|were))\b/i;

const EN_ACTION_BODY =
  `(?:translate\\b[^.!?\\n]{0,60}\\b(?:into|to)\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:write|reply|respond|answer|explain|summarize|output|rewrite|draft|compose|phrase|express|say|give|provide|return|produce)\\b[^.!?\\n]{0,50}\\bin\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:give|provide|write|draft|compose|output|return|produce|show|make)\\b[^.!?\\n]{0,40}\\b(?:an?\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b)`;

const EN_IMPERATIVE_REQUEST_RE = new RegExp(
  `(?:^|(?:[,;]\\s*|\\b(?:and|then|so)\\s+))(?:(?:please|kindly|just|now|only|always)\\s+)*${EN_ACTION_BODY}`,
  "i",
);

const EN_POLITE_REQUEST_RE = new RegExp(
  `\\b(?:can\\s+you|could\\s+you|would\\s+you|will\\s+you|please|i\\s+(?:want|need|would\\s+like)(?:\\s+you)?\\s+to|i['’]d\\s+like(?:\\s+you)?\\s+to)\\s+(?:(?:please|kindly|just)\\s+)*${EN_ACTION_BODY}` +
    `|\\b(?:i\\s+(?:want|need|would\\s+like)|i['’]d\\s+like)\\s+(?:(?:an?|the|some)\\s+)?(?:[a-z]+\\s+){0,2}${FOREIGN_LANG_EN}\\s+${EN_OUTPUT_NOUNS}\\b`,
  "i",
);

const EN_DIRECT_TRANSLATION_NOUN_RE = new RegExp(
  `^\\s*(?:please\\s+)?(?:an?\\s+)?${FOREIGN_LANG_EN}\\s+translation(?:\\s+(?:please|only))?\\s*[:.]?$`,
  "i",
);

const EN_KOREAN_OUTPUT_REQUEST_RE =
  /\b(?:reply|respond|answer|write|explain|summarize|translate|output|speak|talk)\b[^.!?\n]{0,40}\b(?:in|into|to)\s+korean\b/i;

function unwrapUserRequest(stripped) {
  const lower = stripped.toLowerCase();
  if (
    lower.startsWith(USER_REQUEST_OPEN) &&
    lower.endsWith(USER_REQUEST_CLOSE) &&
    stripped.length >= USER_REQUEST_OPEN.length + USER_REQUEST_CLOSE.length
  ) {
    return stripped.slice(USER_REQUEST_OPEN.length, stripped.length - USER_REQUEST_CLOSE.length).trim();
  }
  return stripped;
}

function extractUserRequestBody(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }
  const stripped = rawText.replace(/\r\n?/g, "\n").replace(METADATA_BLOCK_RE, "").trim();
  return stripFencedCodeBlocks(unwrapUserRequest(stripped)).replace(QUOTE_LINE_RE, "").trim();
}

function isSourceDescription(intermediate, action) {
  if (!KO_SOURCE_MODIFIER_RE.test(intermediate)) {
    return false;
  }
  return KO_SOURCE_OBJECT_RE.test(intermediate) || KO_CONSUME_ACTIONS.has(action);
}

function hasValidKoreanEnglishRequest(sentence) {
  if (KO_NEGATED_TRANSLATION_RE.test(sentence) || KO_KOREAN_OUTPUT_REQUEST_RE.test(sentence)) {
    return false;
  }
  const masked = sentence.replace(KO_DESCRIPTIVE_OR_COMPLAINT_RE, DESCRIPTIVE_MASK);

  for (const match of masked.matchAll(KO_LANG_RO_REQUEST_RE)) {
    const intermediate = (match[1] ?? "").trim();
    if (intermediate.length === 0) {
      return true;
    }
    if (KO_INTERMEDIATE_BLOCKLIST_RE.test(intermediate) || isSourceDescription(intermediate, match[2] ?? "")) {
      continue;
    }
    return true;
  }

  return KO_NOUN_MODIFIER_REQUEST_RE.test(masked);
}

function hasValidEnglishRequestClause(clause) {
  if (EN_NEGATED_OUTPUT_RE.test(clause) || EN_NARRATIVE_COMPLAINT_RE.test(clause)) {
    return false;
  }
  return (
    EN_IMPERATIVE_REQUEST_RE.test(clause) ||
    EN_POLITE_REQUEST_RE.test(clause) ||
    EN_DIRECT_TRANSLATION_NOUN_RE.test(clause)
  );
}

function hasValidEnglishRequest(sentence) {
  if (EN_NEGATED_OUTPUT_RE.test(sentence)) {
    return false;
  }
  if (hasValidEnglishRequestClause(sentence)) {
    return true;
  }
  const clauses = sentence
    .split(/(?:,\s*(?:so|but|and)\s+|;\s*|\b(?:so|but)\s+)/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (clauses.length <= 1) {
    return false;
  }
  return clauses.some((clause) => hasValidEnglishRequestClause(clause));
}

export function isExplicitEnglishOutputRequest(rawText) {
  const body = extractUserRequestBody(rawText);
  if (body.length === 0) {
    return false;
  }
  if (SHORT_ENGLISH_REQUEST_RE.test(body)) {
    return true;
  }
  if (KO_NEGATED_TRANSLATION_RE.test(body) || EN_NEGATED_OUTPUT_RE.test(body)) {
    return false;
  }

  const sentences = body
    .split(/[.!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const hasPositiveRequest = sentences.some(
    (sentence) => hasValidKoreanEnglishRequest(sentence) || hasValidEnglishRequest(sentence),
  );
  if (!hasPositiveRequest) {
    return false;
  }

  return !KO_KOREAN_OUTPUT_REQUEST_RE.test(body) && !EN_KOREAN_OUTPUT_REQUEST_RE.test(body);
}
