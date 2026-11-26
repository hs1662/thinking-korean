# hstack

[English](README.md)

`hstack` (v2.2.0)는 외부 npm 의존성이 없는 순수 Node.js 18+ ESM 기반 Antigravity CLI 통합 거버넌스 플러그인입니다. 하나의 플러그인 안에 한국어 모국어 사고·UI·응답 가드, 표결 우회 차단을 포함한 결정론적 증거 기반 완료 게이트, 그리고 옵트인 적대적 사전 검토·위험도 기반 읽기 전용 독립 감사관·팩트 증류 핸드오프 격리 평면을 통합합니다.

## 번들 구성요소 (v2.2.0)

| 구성요소 | 개수 | 상세 |
| --- | :---: | --- |
| `rules` | `1` | `rules/AGENTS.md` (순수 한국어, ASCII 영문자 0자) |
| `hooks` | `1` | `hooks.json`의 `hstack-guard` (`PreToolUse`, `PostInvocation`, `Stop`) |
| `mcpServers` | `1` | `mcp_config.json`의 `gate` (`verify_completion`, `manage_handoff` — v2.2.0 신규 eager 도구 0개) |
| `agents` | `3` | `hstack-auditor`, `hstack-worker`, `hstack-challenger` |
| `skills` | `2` | `hstack-handoff`, `hstack-preflight` |

## 3계층 통합 아키텍처

`hstack`은 규칙, 훅, 즉시 로드(eager) MCP 도구, 서브에이전트, 스킬을 세 계층으로 분리해 운용합니다.

### Layer 1: 한국어 모국어 사고·UI·응답 가드

- `rules/AGENTS.md`는 `<user_rules>`에 상시 로드되는 순수 한국어 규칙 파일(ASCII 영문자 0자)입니다. 내부 추론, 생각 요약, 최종 응답, 사용자 화면 도구 표시 텍스트를 모두 한국어로 고정합니다. 모든 추론 문단 첫 머리에 한국어 요약 선언을 배치하고 내부 추론을 2에서 3문단 이내(문단당 2문장, 전체 6문장 이내)로 압축하며, 최종 응답에서는 파일 이름, 경로, 코드 식별자, 명령어, 고유명사, 기술 영어 단어만 원문으로 유지합니다.
- `PreToolUse` (`scripts/pre-tool-use.mjs`)는 순수 화면 표시 도구(`update_steps`, `ask_question`, `todo_write`, `task_create`, `task_update`, `update_plan`) 실행 직전에 영어 단계 제목이나 선택지를 검사합니다. 영어 이탈이 감지되면 화면 렌더링 전에 `decision: "deny"`와 한국어 교정 사유를 반환하며, 턴당 1회 재시도 상한을 둡니다. `React Router`, `Docker Compose` 같은 짧은 기술 고유명사는 허용합니다.
- `PostInvocation` (`scripts/post-invocation.mjs`)는 모델 호출과 도구 실행이 끝난 뒤 `transcript_full.jsonl`의 최신 `PLANNER_RESPONSE`(`thinking`, `content`, 사용자 표시 `tool_calls`)를 `scripts/analyzer.mjs`로 검사합니다. 전처리기(`scripts/analyzer/stripper.mjs`)는 닫힌 코드 펜스, 인라인 코드, 경로, 플래그, 식별자, XML 태그, `http://`·`https://`·`ftp://`·`file://`·`conversation://` URL, 서버 사고 요약기 고정 폴백 1줄을 제외하고 실제 영어 문장·절·영어 UI 작업 제목 이탈을 감지합니다. 이탈 시 비차단 한국어 `[한국어사고:영어이탈]` `systemMessage`를 주입하며, 복구 인식 백오프(`thinking`·`ui` 단독 이탈 연속 미복구 2회 상한)를 적용합니다. `USER_INPUT`에 명시적인 번역·외국어 작성 요청이 있으면 `thinking`과 체크리스트 검사는 유지하되 `content`만 면제합니다. 또한 `main` 세션에서 완료된 사전 검토가 확인되면 중복 방지 후 `preflight_complete` 레코드를 기록하며, `auditor`·`challenger` 세션은 오염 상태 갱신을 생략합니다.
- 통합 `Stop` (`scripts/stop.mjs`)는 정상 종료(`NO_TOOL_CALL`) 직전에 완료 게이트 준수 여부와 최종 `content` 한국어 이탈을 하나의 오케스트레이터에서 판정합니다(전역 실행 상한 턴당 2회). 위반 유형에 따라 `continue_gate`, `continue_lang`, `continue_dual`로 `decision: "continue"`를 반환하며, `auditor`·`challenger` 세션이거나 마지막 수정 이후 진행 중인 비동기 감사·사전 검토가 있을 때, 또는 오류·비정상 종료 시에는 그대로 통과(`{}`)합니다.

### Layer 2: 결정론적 증거 기반 완료 게이트

- 즉시 로드 MCP 서버(`mcp_config.json`, `scripts/mcp/server.mjs`, `version: "2.2.0"`)가 `mcp_hstack_gate_verify_completion` (`verify_completion`) 도구를 노출합니다.
- `PreToolUse` (`scripts/pre-tool-gate.mjs`)가 `^mcp_hstack_.*$` 호출을 가로채 `decision: "auto_approve"`를 반환하고, 한국어 `toolSummary`와 은닉 `_session` 정보(`conversationId`, `transcriptPath`, `cwd`)를 주입합니다.
- `scripts/governance/fact-ledger.mjs`와 `scripts/governance/decide-gate.mjs`는 보고된 `modified_files`, `inspected_files`, `verification_runs`, `unverified_scope`, `self_assessment`를 트랜스크립트 열람·수정·실행·사전검토·표결 원장과 Git 작업 트리(`git status --porcelain`, `git diff --numstat`)에 결정론적으로 대조합니다.
- `run_command`뿐 아니라 `mcp_agy-fast_fast_run_checks`(검증 실행)와 `mcp_agy-fast_fast_apply_edits`(파일 수정) 같은 외부 MCP 도구도 원장에서 직접 인식합니다.
- 검증 규칙(`R1`~`R9`)과 예외(`E1`~`E11`):
	- `R1_UNREAD_INSPECTED`: 세션에서 직접 읽은 기록이 없는 파일을 `inspected_files`에 포함하면 차단합니다(`write_file`/`write_to_file`로 새로 생성한 파일은 열람으로 인정).
	- `R2_STALE_VERIFICATION`: 코드 수정 이후 검증 실행 기록이 없으면 차단합니다. 문서·에셋 전용 변경(`.md`, `.txt`, `.rst`, `.adoc`, `.svg`, 이미지, `docs/`, `LICENSE`)은 면제(`E1`)하며, 테스트 인프라가 없고 구체적인 `reason_if_na`와 비어 있지 않은 `unverified_scope`를 함께 보고하면 경고로 완화합니다(`E2`).
	- `R3_CONCEALED_FAILURE`: 코드 수정 이후 실패한 검증 실행이 후속 동일·포괄 검증 통과로 해소되지 않으면 차단합니다.
	- `R4_UNREPORTED_MODIFIED`: 현재 턴에서 수정했고 Git 작업 트리에서도 변경 상태인 파일을 `modified_files`에서 누락하면 차단합니다(원복되어 깨끗한 파일은 `E5`로 면제).
	- `R5_FABRICATED_COMMAND`: `outcome: "pass"`로 보고한 검증 명령이 코드 수정 이후 실제 통과 기록과 대조되지 않으면 차단합니다(셸 세그먼트, `run_command`, `mcp_agy-fast_fast_run_checks` 별칭·레이블 지원).
	- `R6_PHANTOM_MODIFIED`: 수정 원장과 Git 변경 목록 어디에도 없는 파일을 보고하면 경고하며, Git 사용 가능 상태에서 턴 수정 기록이 0건이면 차단합니다.
	- `R7_HEDGE_DETECTED`: `self_assessment`에 추측성 표현(`scripts/governance/hedge-detector.mjs`)이 2회 이상 등장하고 유효한 `unverified_scope`가 비어 있으면 경고합니다(`"없음"`, `"none"` 같은 공허 문구는 자동 제외).
	- `R8_AUDIT_REJECTED` / `R8_AUDIT_ERROR`: `TIER_1` 코드 변경에 대한 사후 `hstack-auditor` 감사가 반려되거나 오류·판정 누락으로 종료되면 차단합니다(`E9`·`E10`은 반려 2회 누적 또는 연속 오류 2회 발생 시 `unverified_scope` 기재 조건으로 `PASS_WITH_AUDIT_DEGRADATION` 전환).
	- `R9_PREFLIGHT_UNVOTED`: `main` 세션에서 완료된 사전 검토와 같은 턴에 후속 유효 `ask_question` 표결 없이 코드를 수정하면 `TIER_1` 에스컬레이션보다 먼저 평가합니다. 미표결 `RETHINK`는 `BLOCK`(`REJECT`), 미표결 `CONDITIONAL`·`PROCEED`·`ERROR`·`MISSING_VERDICT`는 `WARN`(`PASS_WITH_WARNING`)을 부여합니다. 예외 `E11`(기존 `E7` 연계)은 3회 반려 누적 후 4회차에 실질 `unverified_scope`가 있으면 교착을 방지하되, `TIER_1` 사후 `hstack-auditor` 독립 감사는 절대 면제하지 않습니다.
	- 그 밖에 세션 경로 미전달 시 생략(`SKIPPED_NO_SESSION`, `E8`), 반복 반려 완화(`E7`), `auditor`·`challenger` 세션 우회, 서브에이전트 역할 격리를 지원합니다.

### Layer 3: 격리 평면 (옵트인 적대적 사전 검토, 독립 코드 감사관, 팩트 증류 핸드오프)

- 옵트인 적대적 사전 검토 평면(`skills/hstack-preflight/SKILL.md`, `agents/hstack-challenger.md`):
	- 미호출 일반 작업에는 마찰이 0입니다. `/hstack-preflight [제안]`(기본), `/hstack-preflight plan [제안]`(설계 전용 — 파일 수정 금지), `/hstack-preflight strict [제안]`(원안 기각 기본 가설 레드팀) 3가지 모드를 지원합니다.
	- 절차: 관련 코드를 읽기 전용으로 확인해 유도 표현을 제거한 4항목 중립 브리프 작성(탈고정) → 읽기 전용 `hstack-challenger`(`invoke_subagent`)의 `파일:줄` 근거 4축 반론(숨은 전제 반증, 실패 모드·폭발 반경, 최소 변경·현상 유지 기준선 비교, 대체 설계안과 트레이드오프; 마지막 비공백 줄 `[사전검토 판정: 진행 가능]` / `[사전검토 판정: 조건부 진행]` / `[사전검토 판정: 재설계 권고]`) → 비교 표 정리 및 내장 `ask_question` 4지선다 표결.
	- 비대화형 실행(`agy -p`) 등에서 `ask_question` 응답이 비어 있거나(`A1:` 뒤 공백) 오류인 경우 절대 파일을 수정하지 않고 비교 표와 선택지 4개만 출력한 뒤 안전 종료합니다. 사전 검토를 거쳐도 완료 검증(`verify_completion`)과 `TIER_1` 사후 `hstack-auditor` 감사는 면제되지 않습니다.
- 위험도 기반 읽기 전용 독립 감사관(`agents/hstack-auditor.md`, `scripts/governance/risk-classifier.mjs`):
	- `classifyRisk`는 민감 경로 변경(`sensitive_path`: `auth`, `security`, `crypto`, `token`, `session`, `migrations`, `hooks.json`, `mcp_config.json`, `scripts/mcp/`, `scripts/governance/` 등), 코드 파일 4개 이상 변경(`large_file_count`), 코드 변경량 150줄 이상(`large_diff_lines`) 중 하나라도 해당하면 `TIER_1`, 그 외에는 `TIER_0`으로 분류합니다.
	- `auditEscalation: "auto"`인 `main` 세션에서 `TIER_1` 코드 변경을 검증하면 `verify_completion`이 `ESCALATE_AUDIT_REQUIRED`를 반환합니다. 코드 수정 이후 `hstack-auditor` 읽기 전용 감사를 실행해 응답 마지막 비공백 줄이 `[감사 판정: 통과]` 또는 `[감사 판정: 반려]`로 끝나야 통과 여부가 결정됩니다.
	- `PreToolUse` (`scripts/pre-tool-gate.mjs`)는 `hstack-auditor`, `hstack-challenger`, `hstack-worker`에 대한 `invoke_subagent` 호출을 가로채 한국어 역할명, 세션 역할 마커(`[hstack:독립감사]`, `[hstack:사전검토]`, `[hstack:격리작업]`), 작업 경로, 트랜스크립트 앵커를 자동 주입합니다.
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

### 옵트인 적대적 사전 검토 (`/hstack-preflight`)

중요한 리팩터링이나 설계 변경에 착수하기 전에 유도 질문에 동조하지 않고 코드 근거 반론과 사용자 표결을 거치고 싶을 때 `/hstack-preflight`를 사용합니다.

- `/hstack-preflight [제안]` (기본): 4항목 중립 브리프를 작성해 읽기 전용 `hstack-challenger` 반론을 받고, 비교 표 정리 후 내장 `ask_question` 4지선다 표결을 거쳐 합의된 범위만 구현합니다. 비대화형 환경(`agy -p`)에서 `ask_question`이 빈 응답이나 오류를 반환하면 파일을 수정하지 않고 비교 표와 선택지 4개만 출력한 뒤 종료합니다.
- `/hstack-preflight plan [제안]`: 설계 전용 모드로, 어떤 파일도 수정하지 않고 반론과 비교 표까지만 수행합니다.
- `/hstack-preflight strict [제안]`: 원안 기각을 기본 가설로 두고 반증 강도를 높여 검토하는 레드팀 모드입니다.

### 팩트 증류 핸드오프 (`/hstack-handoff`)

긴 세션의 컨텍스트를 비우거나 작업을 격리 작업자에게 넘길 때 `/hstack-handoff` 하위 모드를 사용합니다.

- `/hstack-handoff save` (기본값): `manage_handoff(action: "save")`를 호출해 확인된 사실, 실패한 접근, 남은 작업, 열린 위험과 작업 공간 기계 근거를 스냅샷으로 저장합니다.
- `/hstack-handoff load` 또는 `/hstack-handoff load <snapshot_id>`: `manage_handoff(action: "load")`로 최신 또는 지정 스냅샷을 복원하며, 저장 이후 커밋이나 변경 파일 상태가 달라졌으면 경고를 출력합니다.
- `/hstack-handoff list`: `manage_handoff(action: "list")`로 현재 작업 공간의 최근 스냅샷 목록을 조회합니다.
- `/hstack-handoff delegate`: 최신 스냅샷을 저장하거나 불러온 뒤 `invoke_subagent`로 `hstack-worker`에게 압축된 인수인계서와 구체적인 작업·검증 범위를 위임합니다.

### 운영 리포트 CLI (`scripts/audit-report.mjs`)

`audit.jsonl`에 누적된 운영 지표를 7개 섹션으로 요약합니다: `[1]` 전체 요약, `[2]` 기간별 반려율 추이, `[3]` `R1~R9` 규칙 위반·경고 분포(`R9_PREFLIGHT_UNVOTED` 포함), `[4]` Tier 1 독립 감사 현황, `[5]` 컨텍스트 오염 경보 및 미검증 보고, `[6]` 로컬 스캔 지연 통계(`ledgerScanMs`, `gitScanMs`), `[7]` 적대적 사전 검토(Preflight) 현황(턴 중복 제거 집계, 판정 분포, 표결 완료율, `R9_PREFLIGHT_UNVOTED` 차단·경고 건수).

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

### 실측 기준선 요약 (v2.2.0)

- 단위·통합 테스트: `node --test test/*.test.mjs` — **66 스위트 / 262 테스트 통과 (`fail 0`)** (분석기, 영어 요청 면제, 트랜스크립트 훅, 팩트 원장 및 `challenger`·`turnPreflightChallenges`·`turnUserVotes`·5MB 중앙값 `<= 100ms`, 완료 게이트 `R1`~`R9`·`E1`~`E11`, 위험 분류 및 독립 감사, 핸드오프 저장소 및 MCP stdio 왕복, `audit-report.mjs` `[1]`~`[7]` 전수 검증).
- 엄격 플러그인 검증: `agy plugin validate --strict --json .` 종료 코드 `0`, `"findings": []`, `components: { agents: 3, hooks: 1, mcpServers: 1, rules: 1, sidecars: 0, skills: 2 }`.
- 격리 거버넌스 실전 검증(`test/verify-live.mjs`, `L1`~`L11`, `gemini-4-neon-xhigh`): 골든 패스(`L1`), 미검증 반려 복구(`L2`), Stop 우회 복구(`L3`), 읽기 전용 무마찰(`L4`), Tier 1 감사 통과/반려 복구(`L5`/`L6`), 세션 간 핸드오프(`L7`), 저위험 비에스컬레이션(`L8`), `/hstack-preflight plan` 반아첨 반론(`L9`), 비대화형 `/hstack-preflight` 무수정 폴백(`L10`), 일반 리팩터링 무마찰(`L11`) 전수 지원 및 `hookcaller` 패닉 `0`건·가중 사고 한글비 `100.00%` 확인.

릴리스 절차는 [배포 가이드](docs/PUBLISHING.md)에서 확인할 수 있으며 라이선스는 [MIT 라이선스](LICENSE)를 따릅니다.
