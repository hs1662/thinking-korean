# Thinking Korean

영어 문서는 [English documentation](README.md)에서 확인할 수 있습니다.

`thinking-korean`은 모델의 내부 사고 과정(`thinking`)과 최종 응답(`content`)을 처음부터 끝까지 한국어로 유지하는 Antigravity 플러그인입니다. 상시 적용 규칙인 `rules/AGENTS.md`와 상태 없는 `PostInvocation` 드리프트 복구 훅(`hooks.json`에서 `scripts/post-invocation.mjs` 실행)을 함께 사용합니다. 런타임 npm 의존성이 없으며 Node.js 18 이상에서 동작합니다.

## 설치 및 빠른 시작

설치 전에 Antigravity CLI(`agy`)와 Node.js 18 이상이 준비되어 있는지 확인하세요.

1. 로컬 디렉터리 또는 GitHub 저장소에서 플러그인을 설치합니다.

   ```sh
   # 로컬 디렉터리에서 설치
   agy plugin install .

   # GitHub에서 설치
   agy plugin install https://github.com/hs1662/thinking-korean
   ```

2. Antigravity CLI 세션에서 `/thinking`을 실행해 내부 `thinking` 출력이 터미널에 표시되도록 켭니다.
3. 로컬 체크아웃이 Antigravity 플러그인 규칙을 충족하는지 엄격 검증으로 확인합니다.

   ```sh
   agy plugin validate --strict .
   ```

플러그인을 삭제하지 않고 언제든 끄거나 다시 켤 수 있습니다.

```sh
agy plugin disable thinking-korean
agy plugin enable thinking-korean
```

## 동작 원리

`thinking-korean`은 두 계층으로 동작합니다. 첫 번째 계층은 프롬프트 단계에서 영어 전환을 막고, 두 번째 계층은 다단계 도구 호출 도중 발생한 영어 드리프트를 감지해 다음 호출에서 복구합니다.

### `rules/AGENTS.md` 상시 규칙

플러그인이 활성화되면 Antigravity가 `rules/AGENTS.md`를 `<user_rules>`에 병합합니다. 규칙은 다음 항목을 정의합니다.

- 영어와 한국어를 병기한 지시문으로 모든 내부 사고(`thinking`), 사고 요약, 최종 응답(`content`)을 한국어로만 작성하게 합니다. 영어 추론을 유도할 수 있는 영어 예시 문장은 넣지 않았습니다.
- 원문 유지 예외 범위를 명시합니다. 코드 블록, 인라인 코드, 파일 경로, 디렉터리 경로, URL, 코드 식별자(`camelCase`, `snake_case`, `PascalCase`, 상수), CLI 명령어와 하위 명령어와 플래그, 도구 인자 키와 값, 원문 오류 로그 인용, 사용자가 명시적으로 다른 언어나 번역을 요청한 대상 텍스트만 원문을 유지할 수 있습니다.
- 영어 서술이 시작되면 문장을 이어 가지 말고 다음 어절에서 즉시 한국어로 복귀하도록 지시합니다.

### 상태 없는 `PostInvocation` 드리프트 가드

`hooks.json`은 `PostInvocation` 이벤트에 `thinking-korean-drift-guard` 훅을 등록합니다. 모델 호출이 끝날 때마다 Antigravity가 제한 시간 5초로 `node ./scripts/post-invocation.mjs`를 실행합니다.

1. `scripts/post-invocation.mjs`는 표준 입력 JSON에서 `transcriptPath`를 읽습니다. 축약본 `transcript.jsonl` 경로를 받으면 같은 디렉터리의 `transcript_full.jsonl`을 먼저 읽고, 없을 때만 `transcript.jsonl`로 폴백합니다.
2. `scripts/transcript.mjs`는 `parseTranscriptJsonl`로 JSONL 단계를 파싱하고 가장 최근 `PLANNER_RESPONSE` 단계만 검사합니다.
3. `scripts/analyzer.mjs`는 `thinking`과 `content` 각각에 `extractNaturalText`를 적용해 펜스 코드 블록, 인용구(`>`), 인라인 코드, 큰따옴표 문자열, URL, XML 태그, 파일 경로, CLI 플래그, 점 표기 심볼 경로, `snake_case`와 `camelCase`와 `PascalCase` 식별자를 제거합니다.
4. `analyzeField`는 남은 자연어 텍스트를 `scripts/analyzer.mjs`가 내보내는 임계값 상수로 검사합니다.
5. `evaluatePlannerResponse`가 드리프트를 감지하면 `scripts/transcript.mjs`의 `decideHookAction`이 `injectSteps`로 비차단 `systemMessage` 하나를 주입합니다. 메시지는 `DRIFT_MARKER`(`"[thinking-korean:drift]"`)로 시작하며 드리프트가 발생한 필드(`thinking`, `content`, 또는 `thinking and content`)만 지목합니다.

`scripts/analyzer.mjs`가 내보내는 드리프트 판정 상수는 다음과 같습니다.

| 상수 | 값 | 역할 |
| :--- | :--- | :--- |
| `MIN_NATURAL_CHARS` | `24` | 한글과 영문 알파벳 합이 24자 미만이면 검사하지 않습니다(`insufficient`). |
| `MIN_LATIN_CHARS_FOR_DRIFT` | `16` | 영문 알파벳이 16자 미만이면 드리프트로 판정하지 않습니다. |
| `MIN_HANGUL_RATIO` | `0.45` | 전체 필드의 한글 비율이 `0.45` 미만이면 `low_hangul_ratio` 드리프트로 판정합니다. |
| `SEGMENT_MIN_NATURAL_CHARS` | `40` | 문단 또는 줄 단위 세그먼트 검사의 최소 자연어 글자 수입니다. |
| `SEGMENT_MAX_HANGUL_RATIO` | `0.25` | 길이 조건과 최소 영문자 수를 만족하는 세그먼트의 한글 비율이 `0.25` 이하이면 `english_segment` 드리프트로 판정합니다. |
| `ENGLISH_RUN_WORD_THRESHOLD` | `8` | 한 문단 안에서 영문 단어가 8개 이상 연속되면 `english_run` 드리프트로 판정합니다. |

훅은 디스크에 상태를 저장하지 않으며 트랜스크립트만으로 멱등성과 쿨다운을 계산합니다.

- 가장 최근 `PLANNER_RESPONSE` 뒤에 `[thinking-korean:drift]` 마커가 포함된 `SYSTEM_MESSAGE`가 이미 있으면 `already_covered`를 반환하고 `{}`를 출력합니다.
- 복구 메시지를 한 번 주입한 뒤에는 `DEFAULT_COOLDOWN_INVOCATIONS = 2`회의 플래너 응답 동안 추가 주입을 억제하고(`cooldown_active`), 드리프트가 이어지면 세 번째 플래너 응답에서 다시 주입합니다.
- 잘못된 JSON 입력, 누락된 경로, 읽을 수 없는 트랜스크립트, 예기치 않은 오류가 발생하면 항상 `{}`를 출력하고 종료 코드 `0`으로 안전하게 통과합니다.

## 알려진 플랫폼 동작과 한계

Antigravity 플러그인은 터미널에 이미 스트리밍된 토큰을 덮어쓸 수 없으며 모델 API의 사고 언어 파라미터를 직접 설정할 수 없습니다. `PostInvocation` 훅은 드리프트가 발생한 호출이 끝난 뒤 `systemMessage`를 주입하므로, 이미 출력된 토큰을 고치는 대신 다음 모델 호출에서 한국어로 복귀시킵니다.

실제 `agy` 실행(`node test/verify-live.mjs`)에서 측정한 모델별 동작은 다음과 같습니다.

| 모델 | 순수 한국어 추론 | 영어 코드 도구 분석 | 비고 |
| :--- | :--- | :--- | :--- |
| `claude-opus-5-5-high` | 첫 단계에서 한글 사고 비율 `94.5%`, 훅 주입 `0`회로 통과. | `PostInvocation` 드리프트 주입 `1`회 후 한글 사고 비율 `94.3%`로 복구. | `<user_rules>`와 `[thinking-korean:drift]` 복구를 모두 안정적으로 따릅니다. |
| `gemini-4-neon-xhigh`, `gemini-4-carbon-high`, `gemini-3.8-flash-high` | 한글 사고 비율 `90%`에서 `100%` 기록. | 훅 복구 전이나 이후에도 영어 사고 요약이 나올 수 있음. | Gemini는 서버 측 사고 요약기를 통해 `thinking`을 생성합니다. |
| `gpt-oss-120b-medium` | 내부 사고 대부분이 영어로 유지됨. | 내부 사고 대부분이 영어로 유지됨. | `<user_rules>`가 활성화되어도 내부 사고는 대체로 영어로 남습니다. |

## 저장소 구조

저장소는 총 14개 파일을 추적합니다. 추적 파일 목록은 `git ls-files`로 다시 확인할 수 있습니다.

| 경로 | 역할 |
| :--- | :--- |
| `.gitignore` | 로컬 임시 파일(`todo.md`, `.audit/`, `node_modules/`, `.DS_Store`)을 제외합니다. |
| `LICENSE` | MIT 라이선스 전문입니다. |
| `README.md` | GitHub과 Antigravity Marketplace용 영어 문서입니다. |
| `README.ko.md` | 한국어 문서입니다. |
| `assets/logo.svg` | 바깥 여백을 포함한 256x256 정사각형 플러그인 로고입니다. |
| `docs/PUBLISHING.md` | GitHub 릴리스와 Antigravity Marketplace 등록 절차 안내서입니다. |
| `hooks.json` | `PostInvocation` 훅 명령과 제한 시간을 등록합니다. |
| `plugin.json` | Antigravity 플러그인 매니페스트입니다. |
| `rules/AGENTS.md` | 상시 적용 영어 및 한국어 병기 사고 규칙입니다. |
| `scripts/analyzer.mjs` | 자연어 추출과 영어 드리프트 임계값 분석기입니다. |
| `scripts/post-invocation.mjs` | 실행 가능한 `PostInvocation` CLI 진입점과 트랜스크립트 로더입니다. |
| `scripts/transcript.mjs` | JSONL 트랜스크립트 파서, 마커 멱등성, 쿨다운 리듀서, 복구 메시지 생성기입니다. |
| `test/thinking-korean.test.mjs` | 단위 테스트와 서브프로세스 통합 테스트 22개입니다. |
| `test/verify-live.mjs` | 실제 `agy` 모델 대상 검증 스크립트입니다. |

## 검증 방법

분석기, 트랜스크립트 리듀서, `PostInvocation` CLI 어댑터를 다루는 단위 및 서브프로세스 테스트 22개를 실행합니다.

```sh
node --test test/thinking-korean.test.mjs
```

엄격 모드로 플러그인 매니페스트, 로고, 규칙 구조, 훅 설정을 검증합니다.

```sh
agy plugin validate --strict .
```

실제 Antigravity 모델로 라이브 검증을 실행합니다. 스크립트는 임시 워크스페이스의 `.agents/plugins/thinking-korean`에 플러그인을 배치하고 `korean-reasoning`과 `tool-code-analysis` 케이스를 실행한 뒤 `transcript_full.jsonl` 기준 JSON 보고서를 출력합니다.

```sh
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

## 배포 및 라이선스

GitHub 릴리스 태깅과 Antigravity Marketplace 등록 절차는 [배포 및 마켓플레이스 등록 가이드](docs/PUBLISHING.md)를 참고하세요.

이 프로젝트는 [MIT 라이선스](LICENSE)를 따릅니다.
