# Thinking Korean

[English](README.md)

`thinking-korean`은 상시 규칙과 `PostInvocation` 드리프트 복구 훅으로 Antigravity CLI의 `thinking`과 응답을 한국어로 유지하는 플러그인입니다. Node.js 18 이상이 필요하며 npm 의존성은 없습니다.

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

플러그인은 규칙 파일 하나와 훅 스크립트 하나로 동작합니다.

- `rules/AGENTS.md`는 `<user_rules>`에 로드되는 영문 및 국문 병기 규칙으로, 내부 사고와 응답을 한국어로만 작성하게 합니다. 코드, 파일 경로, 식별자, CLI 플래그, URL, 원문 오류 로그 인용, 명시적 번역 대상만 원문을 유지합니다.
- `hooks.json`은 모델 호출이 끝날 때마다 `scripts/post-invocation.mjs`를 실행해 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`를 검사합니다. `thinking`이나 `content`에 영어 서술이 섞이면 상태 없는 2회 호출 쿨다운을 두고 비차단 `[thinking-korean:drift]` `systemMessage`를 한 번 주입합니다. 오류가 나면 `{}`를 반환해 안전하게 통과합니다.

## 모델별 동작과 한계

플러그인은 이미 스트리밍된 토큰을 다시 쓰거나 모델 제공자의 사고 언어 파라미터를 설정할 수 없으므로, 훅 복구는 다음 모델 호출부터 적용됩니다. `test/verify-live.mjs`로 실제 모델을 측정한 결과는 다음과 같습니다.

- `claude-opus-5-5-high`는 순수 추론 첫 단계부터 한글 `94.5%`로 한국어 사고를 유지합니다. 영어 코드 도구 턴에서도 훅 1회 주입 뒤 한글 `94.3%`로 복구합니다.
- `gemini-4-neon-xhigh`, `gemini-4-carbon-high`, `gemini-3.8-flash-high`는 순수 추론에서 한국어 사고 비율 `90%`에서 `100%`를 기록합니다. 반면 영어 코드 도구 턴에서는 Gemini의 서버 측 사고 요약기 때문에 영어 요약이 나올 수 있습니다.
- `gpt-oss-120b-medium`은 내부 사고 대부분이 영어로 남습니다.

## 검증

저장소 루트에서 단위 테스트, 엄격 플러그인 검증, 실제 모델 검증을 실행합니다.

```sh
node --test test/thinking-korean.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

릴리스와 마켓플레이스 등록 절차는 [배포 가이드](docs/PUBLISHING.md)에서 확인할 수 있습니다. 라이선스는 [MIT 라이선스](LICENSE)를 따릅니다.
