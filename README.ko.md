# hstack

[English](README.md)

`hstack` (v2.1.2)는 외부 npm 의존성이 없는 순수 Node.js 18+ ESM 기반 Antigravity CLI 통합 거버넌스 플러그인입니다. 하나의 플러그인 안에 한국어 모국어 사고·UI·응답 가드, 결정론적 증거 기반 완료 게이트, 그리고 위험도 기반 읽기 전용 독립 감사관과 팩트 증류 핸드오프 격리 평면을 통합합니다.

## 3계층 통합 아키텍처

`hstack`은 규칙, 훅, 즉시 로드(eager) MCP 도구, 서브에이전트, 스킬을 세 계층으로 분리해 운용합니다.

### Layer 1: 한국어 모국어 사고·UI·응답 가드

- `rules/AGENTS.md`는 `<user_rules>`에 상시 로드되는 순수 한국어 규칙 파일(ASCII 영문자 0자)입니다. 내부 추론, 생각 요약, 최종 응답, 사용자 화면 도구 표시 텍스트를 모두 한국어로 고정합니다. 모든 추론 문단 첫 머리에 한국어 요약 선언을 배치하고 내부 추론을 2에서 3문단 이내(문단당 2문장, 전체 6문장 이내)로 압축하며, 최종 응답에서는 파일 이름, 경로, 코드 식별자, 명령어, 고유명사, 기술 영어 단어만 원문으로 유지합니다.
- `PreToolUse` (`scripts/pre-tool-use.mjs`)는 순수 화면 표시 도구(`update_steps`, `ask_question`, `todo_write`, `task_create`, `task_update`, `update_plan`) 실행 직전에 영어 단계 제목이나 선택지를 검사합니다. 영어 이탈이 감지되면 화면 렌더링 전에 `decision: "deny"`와 한국어 교정 사유를 반환하며, 턴당 1회 재시도 상한을 둡니다. `React Router`, `Docker Compose` 같은 짧은 기술 고유명사는 허용합니다.
- `PostInvocation` (`scripts/post-invocation.mjs`)는 모델 호출과 도구 실행이 끝난 뒤 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`(`thinking`, `content`, 사용자 표시 `tool_calls`)를 `scripts/analyzer.mjs`로 검사합니다. 전처리기(`scripts/analyzer/stripper.mjs`)는 닫힌 코드 펜스, 인라인 코드, 경로, 플래그, 식별자, XML 태그, `http://`·`https://`·`ftp://`·`file://`·`conversation://` URL, 서버 사고 요약기 고정 폴백 1줄을 제외하고 실제 영어 문장·절·영어 UI 작업 제목 이탈을 감지합니다. 이탈 시 비차단 한국어 `[한국어사고:영어이탈]` `systemMessage`를 주입하며, 복구 인식 백오프(`thinking`·`ui` 단독 이탈 연속 미복구 2회 상한)를 적용합니다. `USER_INPUT`에 명시적인 번역·외국어 작성 요청이 있으면 `thinking`과 체크리스트 검사는 유지하되 `content`만 면제합니다.
- 통합 `Stop` (`scripts/stop.mjs`)는 정상 종료(`NO_TOOL_CALL`) 직전에 완료 게이트 준수 여부와 최종 `content` 한국어 이탈을 하나의 오케스트레이터에서 판정합니다(전역 실행 상한 턴당 2회). 위반 유형에 따라 `continue_gate`, `continue_lang`, `continue_dual`로 `decision: "continue"`를 반환하며, 감사관 세션이나 진행 중인 비동기 감사가 있을 때, 또는 오류·비정상 종료 시에는 그대로 통과(`{}`)합니다.

### Layer 2: 결정론적 증거 기반 완료 게이트

- 즉시 로드 MCP 서버(`mcp_config.json`, `scripts/mcp/server.mjs`)가 `mcp_hstack_gate_verify_completion` (`verify_completion`) 도구를 노출합니다.
- `PreToolUse` (`scripts/pre-tool-gate.mjs`)가 `^mcp_hstack_.*$` 호출을 가로채 `decision: "auto_approve"`를 반환하고, 한국어 `toolSummary`와 은닉 `_session` 정보(`conversationId`, `transcriptPath`, `cwd`)를 주입합니다.
- `scripts/governance/fact-ledger.mjs`와 `scripts/governance/decide-gate.mjs`는 보고된 `modified_files`, `inspected_files`, `verification_runs`, `unverified_scope`, `self_assessment`를 트랜스크립트 열람·수정·실행 원장과 Git 작업 트리(`git status --porcelain`, `git diff --numstat`)에 결정론적으로 대조합니다.
- `run_command`뿐 아니라 `mcp_agy-fast_fast_run_checks`(검증 실행)와 `mcp_agy-fast_fast_apply_edits`(파일 수정) 같은 외부 MCP 도구도 원장에서 직접 인식합니다.
- 검증 규칙(`R1`~`R7`)과 예외(`E1`~`E8`):
	- `R1_UNREAD_INSPECTED`: 세션에서 직접 읽은 기록이 없는 파일을 `inspected_files`에 포함하면 차단합니다(`write_file`/`write_to_file`로 새로 생성한 파일은 열람으로 인정).
	- `R2_STALE_VERIFICATION`: 코드 수정 이후 검증 실행 기록이 없으면 차단합니다. 문서·에셋 전용 변경(`.md`, `.txt`, `.rst`, `.adoc`, `.svg`, 이미지, `docs/`, `LICENSE`)은 면제(`E2`)하며, 테스트 인프라가 없고 구체적인 `reason_if_na`와 비어 있지 않은 `unverified_scope`를 함께 보고하면 경고로 완화합니다(`E1`).
	- `R3_CONCEALED_FAILURE`: 코드 수정 이후 실패한 검증 실행이 후속 동일·포괄 검증 통과로 해소되지 않으면 차단합니다.
	- `R4_UNREPORTED_MODIFIED`: 현재 턴에서 수정했고 Git 작업 트리에서도 변경 상태인 파일을 `modified_files`에서 누락하면 차단합니다(원복되어 깨끗한 파일은 `E3`로 면제).
	- `R5_FABRICATED_COMMAND`: `outcome: "pass"`로 보고한 검증 명령이 코드 수정 이후 실제 통과 기록과 대조되지 않으면 차단합니다(셸 세그먼트, `run_command`, `mcp_agy-fast_fast_run_checks` 별칭·레이블 지원).
	- `R6_PHANTOM_MODIFIED`: 수정 원장과 Git 변경 목록 어디에도 없는 파일을 보고하면 경고하며, Git 사용 가능 상태에서 턴 수정 기록이 0건이면 차단합니다.
	- `R7_HEDGE_DETECTED`: `self_assessment`에 추측성 표현(`scripts/governance/hedge-detector.mjs`)이 2회 이상 등장하고 유효한 `unverified_scope`가 비어 있으면 경고합니다(`"없음"`, `"none"` 같은 공허 문구는 자동 제외).
	- 그 밖에 세션 경로 미전달 시 생략(`SKIPPED_NO_SESSION`), 반려 3회 누적 및 미검증 범위 명시·통과 주장 부재 시 제한 통과(`PASS_WITH_DEGRADATION`), 감사관 세션 우회, 서브에이전트 역할 격리를 지원합니다.

### Layer 3: 격리 평면 (독립 코드 감사관 및 팩트 증류 핸드오프)

- 위험도 기반 읽기 전용 독립 감사관(`agents/hstack-auditor.md`, `scripts/governance/risk-classifier.mjs`):
	- `classifyRisk`는 민감 경로 변경(`sensitive_path`: `auth`, `security`, `crypto`, `token`, `session`, `migrations`, `hooks.json`, `mcp_config.json`, `scripts/mcp/`, `scripts/governance/` 등), 코드 파일 4개 이상 변경(`large_file_count`), 코드 변경량 150줄 이상(`large_diff_lines`) 중 하나라도 해당하면 `TIER_1`, 그 외에는 `TIER_0`으로 분류합니다.
	- `auditEscalation: "auto"`인 `main` 세션에서 `TIER_1` 코드 변경을 검증하면 `verify_completion`이 `ESCALATE_AUDIT_REQUIRED`를 반환합니다. 코드 수정 이후 `hstack-auditor` 읽기 전용 감사를 실행해 응답 마지막 비공백 줄이 `[감사 판정: 통과]` 또는 `[감사 판정: 반려]`로 끝나야 통과 여부가 결정됩니다.
	- `PreToolUse` (`scripts/pre-tool-gate.mjs`)는 `hstack-auditor`와 `hstack-worker`에 대한 `invoke_subagent` 호출을 가로채 한국어 역할명, 세션 역할 마커(`[hstack:독립감사]`, `[hstack:격리작업]`), 작업 경로, 트랜스크립트 앵커를 자동 주입합니다.
	- 규칙 `R8`(`R8_AUDIT_REJECTED`, `R8_AUDIT_ERROR`)은 감사관 반려나 실행 오류·판정 태그 누락 시 차단합니다. 예외 `E9`·`E10`은 감사 반려 2회 누적 또는 연속 오류 2회 발생 시 `unverified_scope`에 잔여 쟁점을 명시하면 `PASS_WITH_AUDIT_DEGRADATION`으로 전환하며, `worker`·`auditor` 세션은 재귀 에스컬레이션하지 않습니다.
- 팩트 증류 컨텍스트 핸드오프(`skills/hstack-handoff/SKILL.md`, `agents/hstack-worker.md`, `scripts/governance/handoff-store.mjs`):
	- 즉시 로드 MCP 도구 `mcp_hstack_gate_manage_handoff` (`manage_handoff`)가 작업 공간 키(`computeWorkspaceKey`) 단위로 `save`, `load`, `list`를 지원합니다. 증류된 팩트(`objective`, `verified_facts`, `failed_approaches`, `remaining_tasks`, `open_risks`)와 기계 근거(Git 브랜치·HEAD·변경 파일, 열람·수정 파일, 검증 기록)를 결합해 저장하고, 불러올 때 작업 트리 변동이 있으면 `[작업 트리 변동 감지]` 경고를 표시합니다.
	- 컨텍스트 오염 추적(`scripts/post-invocation.mjs`의 `updateSessionPollutionState`)은 `inputTokens`, 턴 내 실패 실행 횟수, 단일 파일 반복 수정 횟수를 감시해 임계치 초과 시 완료 검증 영수증에 `[컨텍스트 열화 주의]` 안내를 덧붙입니다.

## 설치 및 `thinking-korean`에서 업그레이드

### 신규 설치

GitHub 저장소나 로컬 디렉터리에서 `hstack`을 설치한 뒤 새 Antigravity CLI 세션을 시작합니다.

```sh
agy plugin install https://github.com/hs1662/thinking-korean
agy plugin install .
```

Antigravity CLI 세션에서 `/thinking`을 실행하면 `thinking` 추론 출력이 표시됩니다.

### `thinking-korean`에서 업그레이드

구버전 훅과 중복 실행되지 않도록 기존 `thinking-korean` 플러그인을 먼저 제거한 뒤 `hstack`을 설치하고, 반드시 새 `agy` 세션을 시작합니다.

```sh
agy plugin uninstall thinking-korean
agy plugin install https://github.com/hs1662/thinking-korean
```

기존 전역 `hstack`을 새 버전으로 재설치할 때도 `plugin_data/hstack/`(`audit.jsonl`, `config.json`, 핸드오프 스냅샷)은 그대로 보존됩니다.

```sh
agy plugin uninstall hstack
agy plugin install /path/to/thinking-korean
```

설치 또는 업그레이드 뒤에는 갱신된 훅, 규칙, 에이전트, 스킬, MCP 서버가 반영되도록 새 `agy` 세션을 시작해야 합니다.

## 설정 레퍼런스 (`config.json` 및 환경 변수)

`hstack`은 아래 경로의 선택적 JSON 설정 파일을 읽습니다.

```text
$ANTIGRAVITY_APP_DATA_DIR/plugin_data/hstack/config.json
```

`PLUGIN_DATA` 또는 `HSTACK_DATA_DIR` 환경 변수가 설정된 경우 해당 디렉터리를 우선합니다. Linux 기본 경로는 `~/.gemini/antigravity-cli/plugin_data/hstack/config.json`입니다.

### 지원 `config.json` 키

| 키 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `schemaRegister` | `"neutral" \| "audit"` | `"neutral"` | 완료 검증 도구 설명과 영수증 어조 레지스터를 선택합니다. |
| `auditEscalation` | `"auto" \| "manual" \| "off"` | `"auto"` | `TIER_1` 독립 감사 에스컬레이션 모드를 제어합니다. `"auto"`는 `main` 세션의 `TIER_1` 코드 변경에 독립 감사를 요구하며 `"manual"`과 `"off"`는 자동 에스컬레이션을 비활성화합니다. |
| `riskThresholds.minCodeFiles` | 양의 정수 | `4` | `TIER_1`(`large_file_count`)으로 분류할 최소 변경 코드 파일 수입니다. |
| `riskThresholds.minChangedLines` | 양의 정수 | `150` | `TIER_1`(`large_diff_lines`)으로 분류할 최소 코드 변경 줄 수(추가+삭제)입니다. |
| `sensitivePatterns` | `string[]` (최대 50개) | 내장 목록 | 기본 민감 경로 정규식 목록을 대체할 대소문자 무시 정규식 문자열 배열입니다. |
| `pollutionThresholds.inputTokensWarning` | 정수 | `120000` | `pollutionAlert`를 발동할 입력 토큰 임계치입니다. |
| `pollutionThresholds.failedExecutionsInTurn` | 정수 | `4` | `pollutionAlert`를 발동할 턴 내 실패 실행 횟수 임계치입니다. |
| `pollutionThresholds.repeatedFileEditChurn` | 정수 | `5` | `pollutionAlert`를 발동할 단일 파일 반복 수정 횟수 임계치입니다. |

`config.json` 예시:

```json
{
	"schemaRegister": "neutral",
	"auditEscalation": "auto",
	"riskThresholds": {
		"minCodeFiles": 4,
		"minChangedLines": 150
	},
	"pollutionThresholds": {
		"inputTokensWarning": 120000,
		"failedExecutionsInTurn": 4,
		"repeatedFileEditChurn": 5
	}
}
```

### 환경 변수와 적용 우선순위

환경 변수가 `config.json`보다 우선하며, 둘 다 없거나 유효하지 않으면 내장 기본값을 사용합니다.

1. `HSTACK_SCHEMA_REGISTER` (`"neutral"` 또는 `"audit"`) > `config.json`의 `schemaRegister` > `"neutral"`.
2. `HSTACK_AUDIT_ESCALATION` (`"auto"`, `"manual"`, `"off"`) > `config.json`의 `auditEscalation` > `"auto"`.

## 사용 가이드

### 팩트 증류 핸드오프 (`/hstack-handoff`)

긴 세션의 컨텍스트를 비우거나 작업을 격리 작업자에게 넘길 때 `/hstack-handoff` 하위 모드를 사용합니다.

- `/hstack-handoff save` (기본값): `manage_handoff(action: "save")`를 호출해 확인된 사실, 실패한 접근, 남은 작업, 열린 위험과 작업 공간 기계 근거를 스냅샷으로 저장합니다.
- `/hstack-handoff load` 또는 `/hstack-handoff load <snapshot_id>`: `manage_handoff(action: "load")`로 최신 또는 지정 스냅샷을 복원하며, 저장 이후 커밋이나 변경 파일 상태가 달라졌으면 경고를 출력합니다.
- `/hstack-handoff list`: `manage_handoff(action: "list")`로 현재 작업 공간의 최근 스냅샷 목록을 조회합니다.
- `/hstack-handoff delegate`: 최신 스냅샷을 저장하거나 불러온 뒤 `invoke_subagent`로 `hstack-worker`에게 압축된 인수인계서와 구체적인 작업·검증 범위를 위임합니다.

### 운영 리포트 CLI (`scripts/audit-report.mjs`)

`audit.jsonl`에 누적된 완료 게이트 반려율, `R1`~`R8` 위반 분포, Tier 1 독립 감사 통과율, 컨텍스트 오염 경보, 로컬 스캔 지연 통계를 터미널 표나 JSON으로 요약합니다.

```sh
node ./scripts/audit-report.mjs
node ./scripts/audit-report.mjs --days 7
node ./scripts/audit-report.mjs --since 2026-11-20 --group-by week
node ./scripts/audit-report.mjs --days 7 --json
node ./scripts/audit-report.mjs --file /path/to/audit.jsonl
```

`--file`을 생략하면 `$PLUGIN_DATA/audit.jsonl`, `$HSTACK_DATA_DIR/audit.jsonl`, `$ANTIGRAVITY_APP_DATA_DIR/plugin_data/hstack/audit.jsonl`, `~/.gemini/antigravity-cli/plugin_data/hstack/audit.jsonl`, `resolvePluginDataDir()/audit.jsonl` 순서로 기본 로그 파일을 찾습니다.

## 검증 및 테스트

저장소 루트에서 단위·통합 테스트, 엄격 플러그인 검증, 격리된 실전 모델 검증을 실행합니다.

```sh
node --test test/*.test.mjs
agy plugin validate --strict --json .
node ./test/verify-live.mjs --models gemini-4-neon-xhigh
```

`test/verify-live.mjs`는 전역 플러그인 간섭을 차단하기 위해 격리된 임시 `HOME`과 앱 데이터 디렉터리에서 실행되며 종료 시 임시 로그를 자동 정리합니다.

### 실측 기준선 요약

- 단위·통합 테스트: `node --test test/*.test.mjs`로 분석기, 영어 요청 면제, 트랜스크립트 훅, 팩트 원장, 완료 게이트(`R1`~`R7`), 위험 분류 및 독립 감사(`R8`/`E9`/`E10`), 핸드오프 저장소 및 MCP stdio 왕복, `audit-report.mjs` CLI를 전수 검증합니다.
- 엄격 플러그인 검증: `agy plugin validate --strict --json .` 종료 코드 `0`, `"findings": []`.
- 격리 한국어 실측 기준선(`gemini-4-neon-xhigh`, 5개 케이스 `korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, `explicit-translation`, `todo-checklist`): 5/5 통과, `driftInjections: 0`, `preToolDenials: 0`, 가중 사고 한글비 `93.65%`~`100.0%`.
- 전역 `hstack` 거버넌스 실측: Tier 0 즉시 통과, Tier 1 독립 감사 자동 에스컬레이션 및 통과, `/hstack-handoff save`·`load`·`delegate` 격리 작업자 완료, 재설치 전후 `audit.jsonl` 무손실 확인.

릴리스 절차는 [배포 가이드](docs/PUBLISHING.md)에서 확인할 수 있으며 라이선스는 [MIT 라이선스](LICENSE)를 따릅니다.
