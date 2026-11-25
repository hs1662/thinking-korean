# Thinking Korean

[English](README.md)

`thinking-korean`은 자연스러운 한국어 대화체 규칙과 `PreToolUse`, `PostInvocation`, `Stop` 드리프트 복구 훅으로 Antigravity CLI의 `thinking`, 사용자 화면 도구 표시 텍스트(작업 단계 체크리스트, 도구 요약, 서브에이전트 역할, 질문 선택지), 그리고 응답을 한국어로 유지하는 플러그인입니다. Node.js 18 이상이 필요하며 npm 의존성은 없습니다.

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

플러그인은 상시 규칙 파일 하나와 세 개의 라이프사이클 훅(`PreToolUse`, `PostInvocation`, `Stop`)으로 동작합니다.

- `rules/AGENTS.md`는 `<user_rules>`에 로드되는 한국어 전용 규칙 파일입니다. 내부 추론, 생각 요약, 최종 응답은 물론 사용자 화면에 표시되는 작업 단계 체크리스트(할 일 목록 제목), 도구 실행 요약, 서브에이전트 역할 이름, 질문·선택지, 아티팩트 요약까지 자연스러운 한국어 문장으로 작성하게 합니다. 모든 추론 문단의 첫 문장에 한국어 요약 고정 선언을 넣고 6에서 8문단 이내(문단당 3에서 4문장)로 간결하게 정리하게 해 서버 측 사고 요약기가 청크 단위로 영어로 넘어가는 현상을 막습니다. 파일 이름, 경로, 코드 식별자, 명령어, 고유명사, 한국어 기술 대화에서 자연스럽게 쓰는 영어 단어와 용어는 억지로 음차하지 않고 문장 안에 그대로 허용하며 영어 문장, 영어 절, 영어 문단 이탈만 금지합니다.
- `hooks.json`의 `PreToolUse`는 순수 사용자 표시 도구(`update_steps`, `ask_question`, `todo_write`, `task_create`, `task_update`, `update_plan`) 실행 직전에 `scripts/pre-tool-use.mjs`를 실행합니다. 작업 단계 제목이나 선택지가 영어로 이탈하면 화면에 렌더링되기 전에 `decision: "deny"`와 한국어 교정 사유를 반환하며, 턴당 1회 무상태 재시도 상한으로 무한 차단을 막습니다.
- `hooks.json`의 `PostInvocation`은 모델 호출과 도구 실행이 끝난 뒤 `scripts/post-invocation.mjs`를 실행해 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`(`thinking`, `content`, `tool_calls` 화면 표시 텍스트)를 검사합니다. 분석기(`scripts/analyzer.mjs`)는 한국어 문장 안에 자연스럽게 섞인 1에서 3단어 비산문 영어 기술 용어와 코드, 경로, 식별자는 오탐하지 않고 영어 문장, 축약형 절, 4단어 이상 연속 영어 구절, 영어 문단, 영어 화면 표시 제목 이탈만 감지합니다. 영어 이탈이 감지되면 한국어 `[한국어사고:영어이탈]` `systemMessage`를 비차단으로 주입하며, 무상태 복구 인식 백오프를 적용합니다.
  - 한국어로 복구되면 실패 횟수와 쿨다운을 즉시 초기화합니다.
  - `thinking` 단독 또는 `ui` 단독 이탈이 계속되면 백오프 후 연속 미복구 상한(`2`회)에 도달할 때 추가 주입을 중단해 컨텍스트 오염을 막고, 실제 한국어 출력이 다시 나오면 상한을 해제합니다.
  - 사용자 응답(`content`) 이탈은 독립 예산을 유지하며, `USER_INPUT`에 명시적인 영어 번역·작성 요청이 있으면 `thinking`과 작업 단계 체크리스트 검사는 유지하되 `content`만 면제합니다.
- `hooks.json`의 `Stop`은 정상 종료(`NO_TOOL_CALL`) 직전 `scripts/stop.mjs`를 실행합니다. 명시적인 번역 요청이 아닌데 최종 사용자 응답(`content`)이 영어로 이탈한 경우에만 `decision: "continue"`를 1회 반환해 한국어 응답으로 교정합니다. 같은 턴 앞선 스텝의 `thinking`·`ui` 전용 마커는 `Stop` 복구를 막지 않으며, 이미 재시도 중(`continuationActive: true`)이거나 비정상 종료, 또는 `content`가 이미 한국어인 경우에는 그대로 통과합니다.
- 훅 실패 시 통과 규칙: `PreToolUse`는 호출을 허용할 때와 읽기, 파싱, 예외 오류가 났을 때 모두 `{"decision":"allow"}`를 반환합니다. `PostInvocation`과 `Stop`은 아무 조치가 필요 없을 때와 같은 오류가 났을 때 `{}`를 반환해 그대로 통과합니다.

복구 동작의 세부 사항은 다음과 같습니다.

- 주입 메시지는 이탈한 필드를 함께 적은 구조화 마커로 시작합니다. 예를 들어 `[한국어사고:영어이탈][대상:추론+응답]`처럼 쓰며, `추론`은 `thinking`, `응답`은 `content`, `화면`은 `ui`를 뜻합니다. 대상 태그가 없는 기존 `[한국어사고:영어이탈]` 마커와 예전 `[thinking-korean:drift]` 마커도 계속 인식합니다.
- `PreToolUse`가 호출을 거부한 뒤에는 `PostInvocation`이 `ui` 필드를 이미 교정된 것으로 보고 같은 이탈에 대해 메시지를 한 번 더 주입하지 않습니다.
- 한국어로 복구되면 재시도 상한을 초기화합니다. 같은 화면 표시 도구를 한국어로 다시 호출해 통과하면 `PreToolUse` 재시도 횟수가 0으로 돌아가고, 한국어 출력이 나오면 해당 필드의 `PostInvocation` 실패 횟수와 쿨다운도 초기화됩니다.
- `React Router`, `Docker Compose`처럼 짧은 기술 고유명사(Title Case 단어, 약어, 버전으로만 이뤄진 4단어 이하)만으로 된 선택지나 단계 제목은 영어 이탈로 보지 않고 허용합니다.

모듈 구성은 다음과 같습니다.

- `scripts/analyzer.mjs`는 분석기 진입점이며 `scripts/analyzer/`의 모듈(`constants.mjs`, `lexicon.mjs`, `lines.mjs`, `prose-rules.mjs`, `stripper.mjs`, `ui.mjs`)을 다시 내보냅니다.
- `scripts/transcript.mjs`는 트랜스크립트 처리 진입점이며 `scripts/transcript/`의 모듈(`steps.mjs`, `english-request.mjs`, `ui-extractor.mjs`, `markers.mjs`, `trackers.mjs`, `decide-post.mjs`, `decide-pre-tool.mjs`, `decide-stop.mjs`)을 다시 내보냅니다.
- `scripts/hook-io.mjs`는 훅 진입점 `scripts/pre-tool-use.mjs`, `scripts/post-invocation.mjs`, `scripts/stop.mjs`가 함께 쓰는 표준 입력 읽기, 트랜스크립트 읽기, JSON 출력 코드를 담고 있습니다.

## 모델별 동작과 한계

플러그인은 이미 스트리밍된 토큰을 다시 쓰거나 모델 제공자의 사고 언어 파라미터를 설정할 수 없으므로, 훅 복구는 다음 모델 호출부터 적용됩니다. 격리된 환경에서 실제 모델을 측정한 결과는 다음과 같습니다.

- `gemini-4-neon-xhigh`는 현재 코드 기준 격리 검증 5개 전 케이스(`korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, `explicit-translation`, `todo-checklist`)를 모두 통과했습니다. `driftInjections: 0`, `preToolDenials: 0`이었고 모든 케이스에서 가중 사고 한글비가 `100.0%`였습니다. `explicit-translation`은 `contentExemptionPassed: true`였고, `todo-checklist`에서는 `update_steps`가 실제로 실행됐습니다(`requiredToolsExecuted: { update_steps: true }`). 실행 명령은 `node test/verify-live.mjs --models gemini-4-neon-xhigh --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation,todo-checklist --timeout 180`입니다.

아래 결과는 이전 코드 버전에서 4개 케이스(`todo-checklist` 제외)로 측정한 이전 실측 기준이며, 현재 코드로는 다시 측정하지 않았습니다.

- `gemini-3.8-flash-high`는 4개 전 케이스를 2회 연속 훅 주입 `0`회, 사고 가중 한글비 `97.4%`에서 `100.0%`(응답 `80.1%`에서 `99.2%`, 번역 면제 통과)로 모두 통과했습니다.
- `claude-opus-5-5-high`는 직전 자연 한국어 규칙 기준 격리 검증에서 `korean-reasoning` 한글비 `94.0%`(응답 `92.9%`)와 `tool-code-analysis` 한글비 `91.1%`(응답 `94.5%`)를 훅 주입 `0`회로 통과했습니다. 최종 매 문단 고정 규칙과 `Stop` 훅 적용 버전은 계정 할당량 제한(`429`) 해제 뒤 재검증이 필요합니다.
- `gpt-oss-120b-medium`은 내부 사고 대부분이 영어로 남으며, `thinking` 단독 상한으로 불필요한 반복 주입을 차단합니다.

## 검증

저장소 루트에서 단위 테스트, 엄격 플러그인 검증, 격리된 실제 모델 검증을 실행합니다.

```sh
node --test test/*.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

`test/verify-live.mjs`는 전역 플러그인 간섭을 막기 위해 격리된 임시 `HOME`과 앱 데이터 디렉터리에서 실행되고 종료 시 임시 로그를 자동 삭제하며, 다음 옵션을 지원합니다.

```sh
node test/verify-live.mjs \
  --models gemini-4-neon-xhigh,claude-opus-5-5-high \
  --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation,todo-checklist \
  --timeout 180 \
  --keep-logs
```

릴리스와 마켓플레이스 등록 절차는 [배포 가이드](docs/PUBLISHING.md)에서 확인할 수 있습니다. 라이선스는 [MIT 라이선스](LICENSE)를 따릅니다.
