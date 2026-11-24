# Thinking Korean

[English](README.md)

`thinking-korean`은 자연스러운 한국어 대화체 규칙과 `PostInvocation` 및 `Stop` 드리프트 복구 훅으로 Antigravity CLI의 `thinking`과 응답을 한국어로 유지하는 플러그인입니다. Node.js 18 이상이 필요하며 npm 의존성은 없습니다.

## 설치

GitHub 저장소나 로컬 디렉터리에서 플러그인을 설치합니다.

```sh
agy plugin install https://github.com/hs1662/thinking-korean
agy plugin install .
```

Antigravity CLI 세션에서 `/thinking`을 실행하면 `thinking` 출력이 표시됩니다.

플러그인을 끄거나 다시 켤 때는 아래 명령어를 실행합니다.

```sh
agy plugin disable thinking-korean
agy plugin enable thinking-korean
```

## 동작 방식

플러그인은 상시 규칙 파일 하나와 두 개의 라이프사이클 훅(`PostInvocation`, `Stop`)으로 동작합니다.

- `rules/AGENTS.md`는 `<user_rules>`에 로드되는 한국어 전용 규칙 파일입니다. 내부 추론, 생각 요약, 최종 응답을 사용자와 한국어로 직접 대화하듯 자연스러운 한국어 문장으로 작성하게 합니다. 모든 추론 문단의 첫 문장에 한국어 요약 고정 선언을 넣고 6에서 8문단 이내(문단당 3에서 4문장)로 간결하게 정리하게 해 서버 측 사고 요약기가 청크 단위로 영어로 넘어가는 현상을 막습니다. 파일 이름, 경로, 코드 식별자, 명령어, 고유명사, 한국어 기술 대화에서 자연스럽게 쓰는 영어 단어와 용어는 억지로 음차하지 않고 문장 안에 그대로 허용하며 영어 문장, 영어 절, 영어 문단 이탈만 금지합니다.
- `hooks.json`의 `PostInvocation`은 모델 호출과 도구 실행이 끝난 뒤 `scripts/post-invocation.mjs`를 실행해 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`를 검사합니다. 분석기(`scripts/analyzer.mjs`)는 한국어 문장 안에 자연스럽게 섞인 1에서 3단어 비산문 영어 기술 용어와 코드, 경로, 식별자는 오탐하지 않고 영어 문장, 축약형 절, 4단어 이상 연속 영어 구절, 영어 문단 이탈만 감지합니다. 영어 이탈이 감지되면 한국어 `[한국어사고:영어이탈]` `systemMessage`를 비차단으로 주입하며, 무상태 복구 인식 백오프를 적용합니다.
  - 한국어로 복구되면 실패 횟수와 쿨다운을 즉시 초기화합니다.
  - `thinking` 단독 이탈이 계속되면 백오프 후 연속 미복구 상한(`2`회)에 도달할 때 추가 주입을 중단해 컨텍스트 오염을 막고, 실제 한국어 `thinking`이 다시 나오면 상한을 해제합니다.
  - 사용자 응답(`content`) 이탈은 독립 예산을 유지하며, `USER_INPUT`에 명시적인 영어 번역·작성 요청이 있으면 `thinking` 검사는 유지하되 `content`만 면제합니다.
- `hooks.json`의 `Stop`은 정상 종료(`NO_TOOL_CALL`) 직전 `scripts/stop.mjs`를 실행합니다. 명시적인 번역 요청이 아닌데 최종 사용자 응답(`content`)이 영어로 이탈한 경우에만 `decision: "continue"`를 1회 반환해 한국어 응답으로 교정합니다. 이미 재시도 중(`continuationActive: true`)이거나 비정상 종료, 또는 `content`가 이미 한국어인 경우에는 그대로 통과합니다.
- 두 훅 모두 읽기, 파싱, 이벤트 오류가 발생하면 `{}`를 반환해 안전하게 통과합니다.

## 모델별 동작과 한계

플러그인은 이미 스트리밍된 토큰을 다시 쓰거나 모델 제공자의 사고 언어 파라미터를 설정할 수 없으므로, 훅 복구는 다음 모델 호출부터 적용됩니다. 격리된 환경에서 실제 모델을 측정한 결과는 다음과 같습니다.

- `gemini-4-neon-xhigh`는 매 문단 한국어 요약 고정과 간결 문단 규칙 적용 뒤 최종 코드 기준 공식 격리 검증 4개 전 케이스(`korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, `explicit-translation`)를 2회 연속 훅 주입 `0`회, 전 스텝 사고 한글비 `100.0%`(응답 `84.8%`에서 `96.2%`, 번역 면제 통과)로 모두 통과했습니다. `src/analyzer.mjs`, `docs/SKILL.md`, `analyzeField` 같은 원문 식별자를 억지 한글 음차 없이 그대로 쓰면서도 첫 스텝부터 마지막 문단까지 한국어 사고가 유지됩니다.
- `gemini-3.8-flash-high`도 최종 코드 기준 공식 격리 검증 4개 전 케이스를 2회 연속 훅 주입 `0`회, 사고 가중 한글비 `97.4%`에서 `100.0%`(응답 `80.1%`에서 `99.2%`, 번역 면제 통과)로 모두 통과했습니다.
- `claude-opus-5-5-high`는 직전 자연 한국어 규칙 기준 격리 검증에서 `korean-reasoning` 한글비 `94.0%`(응답 `92.9%`)와 `tool-code-analysis` 한글비 `91.1%`(응답 `94.5%`)를 훅 주입 `0`회로 통과했습니다. 최종 매 문단 고정 규칙과 `Stop` 훅 적용 버전은 계정 할당량 제한(`429`) 해제 뒤 재검증이 필요합니다.
- `gpt-oss-120b-medium`은 내부 사고 대부분이 영어로 남으며, `thinking` 단독 상한으로 불필요한 반복 주입을 차단합니다.

## 검증

저장소 루트에서 단위 테스트, 엄격 플러그인 검증, 격리된 실제 모델 검증을 실행합니다.

```sh
node --test test/thinking-korean.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

`test/verify-live.mjs`는 전역 플러그인 간섭을 막기 위해 격리된 임시 `HOME`과 앱 데이터 디렉터리에서 실행되고 종료 시 임시 로그를 자동 삭제하며, 다음 옵션을 지원합니다.

```sh
node test/verify-live.mjs \
  --models gemini-4-neon-xhigh,claude-opus-5-5-high \
  --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation \
  --timeout 180 \
  --keep-logs
```

릴리스와 마켓플레이스 등록 절차는 [배포 가이드](docs/PUBLISHING.md)에서 확인할 수 있습니다. 라이선스는 [MIT 라이선스](LICENSE)를 따릅니다.
