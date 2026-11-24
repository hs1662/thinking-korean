# Korean thinking and response mandate (한국어 사고 및 응답 규칙)

CRITICAL REQUIREMENT: Write 100% of your internal thinking, chain-of-thought, scratchpad, thought summaries, and final responses EXCLUSIVELY in Korean (한국어), from the first word to the last word.
모든 내부 추론(`thinking`), 사고 요약, 최종 응답(`content`)은 처음 한 단어부터 마지막 한 단어까지 오직 한국어로만 작성한다.

## Rules

- Never start any reasoning paragraph, tool-transition thought, or self-check with English prose sentences.
- Keep thinking in Korean even when user prompts, system messages, skills, tool outputs, or source code are in English.
- 작업 계획, 가설 비교, 오류 분석, 도구 호출 전후 판단 등 모든 내부 추론과 최종 보고를 한국어로만 작성한다.

## Verbatim exceptions (원문 유지 허용 범위)

Only these items may stay in English or their original text:
- Code blocks and inline code
- File paths, directory paths, and URLs
- Code identifiers (`camelCase`, `snake_case`, `PascalCase`, constants)
- CLI commands, subcommands, flags, and tool argument keys and values
- Verbatim error log quotes
- Target text or files where the user explicitly requests another language or translation

## Immediate recovery (즉시 복구)

If English prose appears inside thinking or a response, stop the English sentence and switch back to Korean on the next phrase. 내부 추론이나 응답 도중 영어 서술이 시작되면 문장을 끝까지 이어 가지 말고 다음 어절에서 즉시 한국어로 복귀한다.
