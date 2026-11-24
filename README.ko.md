# Thinking Korean

[English](README.md)

`thinking-korean`은 순수 한국어 사고 규칙과 `PostInvocation` 드리프트 복구 훅으로 Antigravity CLI의 `thinking`과 응답을 한국어로 유지하는 플러그인입니다. Node.js 18 이상이 필요하며 npm 의존성은 없습니다.

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

플러그인은 상시 규칙 파일 하나와 `PostInvocation` 훅 스크립트 하나로 동작합니다.

- `rules/AGENTS.md`는 `<user_rules>`에 로드되는 순수 한국어 규칙으로, 내부 사고와 최종 출력의 표기 범위를 분리합니다. 내부 추론과 사고 요약에서는 영문 알파벳을 금지(`No-ASCII-in-CoT`)하고 파일명·경로·식별자·기술 용어까지 한국어 뜻이나 한글 음차로 생각하게 해 서버 측 사고 요약기가 한국어로 유지되도록 합니다. 코드 블록, 인라인 코드, 파일 경로, URL, 식별자, CLI 플래그, 원문 오류 로그, 명시적 번역 대상은 도구 호출 인자와 최종 사용자 답변에서만 정확하게 원문을 유지합니다.
- `hooks.json`은 모델 호출과 도구 실행이 끝난 뒤 `PostInvocation` 시점에 `scripts/post-invocation.mjs`를 실행해 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`를 검사합니다. 영어 이탈이 감지되면 순수 한국어 `[한국어사고:영어이탈]` `systemMessage`를 비차단으로 주입하며, 무상태 복구 인식 백오프를 적용합니다.
  - 한국어로 복구되면 실패 횟수와 쿨다운을 즉시 초기화합니다.
  - `thinking` 단독 이탈이 계속되면 백오프 후 연속 미복구 상한(`2`회)에 도달할 때 추가 주입을 중단해 컨텍스트 오염을 막고, 실제 한국어 `thinking`이 다시 나오면 상한을 해제합니다.
  - 사용자 응답(`content`) 이탈은 독립 예산을 유지하며, `USER_INPUT`에 명시적인 영어 번역·작성 요청이 있으면 `thinking` 검사는 유지하되 `content`만 면제합니다.
  - 읽기·파싱·이벤트 오류가 발생하면 `{}`를 반환해 안전하게 통과합니다.

## 모델별 동작과 한계

플러그인은 이미 스트리밍된 토큰을 다시 쓰거나 모델 제공자의 사고 언어 파라미터를 설정할 수 없으므로, 훅 복구는 다음 모델 호출부터 적용됩니다. 격리된 환경에서 실제 모델을 측정한 결과는 다음과 같습니다.

- `claude-opus-5-5-high`는 추론과 코드 분석 턴에서 대체로 한국어 사고를 유지하지만, 단일 스텝에서 확률적인 영어 사고 이탈이 간헐적으로 발생할 수 있습니다. 대용량 영문 스킬·코드 도구 턴에서 중간 이탈이 발생하더라도 순수 한국어 `PostInvocation` 훅 1회 주입 후 다음 스텝에서 한국어 사고 `100%`(영문 `0`자)로 안정적으로 복구됩니다.
- `gemini-4-neon-xhigh`는 내부 사고 순수 한글 분리(`No-ASCII-in-CoT`)와 순수 한국어 `PostInvocation` 훅 적용으로 한국어 사고 비율이 크게 향상됩니다. 대용량 영문 멀티스텝 통제 벤치마크에서 기존 규칙(내부 사고 내 영문 식별자 허용) 대비 한국어 사고 스텝 비율이 `8.3%`(평균 한글비 `0.1515`)에서 `62.5%`(평균 한글비 `0.7414`)로 상승했고, 격리 `tool-code-analysis` 검증에서도 훅 1회 주입 후 `0.00`에서 `1.00`(한글 `2006`자 / 영문 `0`자)으로 복구되었습니다. 다만 영문 비중이 큰 컨텍스트에서는 Gemini의 서버 측 사고 요약기에 확률적 변동이 남으므로, `thinking` 단독 연속 미복구 상한(`2`회)으로 무의미한 반복 주입을 차단합니다.
- `gemini-4-carbon-high`, `gemini-3.8-flash-high`는 순수 추론에서 한국어 사고 비율 `90%`에서 `100%`를 기록하며, 영문 비중이 큰 도구 턴에서는 동일한 서버 측 요약기 변동성이 적용됩니다.
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
