# hstack

[한국어](README.ko.md)

`hstack` (v2.2.0) is an Antigravity CLI governance plugin built on Node.js 18+ ESM with zero npm dependencies. It combines three layers in one plugin: a Korean-native thinking, UI, and response guard, a deterministic evidence-grounded completion gate with preflight vote-bypass enforcement, and an isolation plane with opt-in adversarial preflight challenge, risk-tiered independent code auditing, and fact-distilled cross-session handoff.

## Bundled components (v2.2.0)

| Component | Count | Details |
| --- | :---: | --- |
| `rules` | `1` | `rules/AGENTS.md` (pure Korean, zero ASCII letters) |
| `hooks` | `1` | `hstack-guard` in `hooks.json` (`PreToolUse`, `PostInvocation`, `Stop`) |
| `mcpServers` | `1` | `gate` in `mcp_config.json` (`verify_completion`, `manage_handoff`; zero new eager tools in v2.2.0) |
| `agents` | `3` | `hstack-auditor`, `hstack-worker`, `hstack-challenger` |
| `skills` | `2` | `hstack-handoff`, `hstack-preflight` |

## Architecture

`hstack` organizes its rules, hooks, eager MCP tools, subagents, and skills into three layers.

### Layer 1: Korean-native thinking, UI, and response guard

- `rules/AGENTS.md` is an always-on, pure-Korean rule file (zero ASCII letters) loaded into `<user_rules>`. It fixes Korean as the model's native language across internal reasoning, thought summaries, final responses, and user-facing tool UI labels. It caps internal reasoning at 2 to 3 short paragraphs (at most 2 sentences per paragraph, 6 sentences total) with a Korean summary-language declaration at the start of each paragraph, while keeping file names, paths, code identifiers, commands, proper nouns, and everyday English technical terms verbatim inside natural Korean replies.
- `PreToolUse` (`scripts/pre-tool-use.mjs`) checks pure UI display tools (`update_steps`, `ask_question`, `todo_write`, `task_create`, `task_update`, `update_plan`) before they render. English step titles or option labels receive `decision: "deny"` with a Korean correction reason, capped at one retry per turn. Short technical proper names such as `React Router` or `Docker Compose` are allowed.
- `PostInvocation` (`scripts/post-invocation.mjs`) scans `transcript_full.jsonl` after each model invocation and evaluates `thinking`, `content`, and user-facing `tool_calls` text through `scripts/analyzer.mjs`. The stripper (`scripts/analyzer/stripper.mjs`) excludes closed fenced code blocks, inline code spans, paths, flags, identifiers, XML tags, `http://`, `https://`, `ftp://`, `file://`, and `conversation://` URLs, and server-side summarizer boilerplate while catching English prose, clauses, and English UI task labels. Drift triggers a non-blocking Korean `[한국어사고:영어이탈]` `systemMessage` with recovery-aware backoff (`2` consecutive unrecovered cap for `thinking`-only or `ui`-only drift). Explicit translation or foreign-language requests in `USER_INPUT` exempt `content` while keeping `thinking` and checklists in Korean. It also logs deduplicated `preflight_complete` records once completed preflight challenges occur in `main` sessions while skipping pollution updates for `auditor` and `challenger` sessions.
- Unified `Stop` (`scripts/stop.mjs`) runs before a normal `NO_TOOL_CALL` turn ends. It checks both completion-gate compliance and Korean `content` drift in one orchestrator (global cap: 2 executions per turn). It returns `decision: "continue"` with `continue_gate`, `continue_lang`, or `continue_dual` when needed, skips `auditor` and `challenger` sessions as well as turns with pending post-write async audits or challenges, and fails open (`{}`) on errors or abnormal termination.

### Layer 2: deterministic evidence-grounded completion gate

- Eager MCP server (`mcp_config.json`, `scripts/mcp/server.mjs`, `version: "2.2.0"`) exposes `mcp_hstack_gate_verify_completion` (`verify_completion`) without requiring schema discovery turns.
- `PreToolUse` (`scripts/pre-tool-gate.mjs`) intercepts `^mcp_hstack_.*$` calls to return `decision: "auto_approve"`, set a Korean `toolSummary`, and inject hidden `_session` metadata (`conversationId`, `transcriptPath`, `cwd`) stripped before schema validation.
- `scripts/governance/fact-ledger.mjs` and `scripts/governance/decide-gate.mjs` cross-check claimed `modified_files`, `inspected_files`, `verification_runs`, `unverified_scope`, and `self_assessment` against transcript read/write/execution/preflight/vote history and Git working tree state (`git status --porcelain`, `git diff --numstat`).
- External MCP verification tools such as `mcp_agy-fast_fast_run_checks` (and `mcp_agy-fast_fast_apply_edits` for writes) are recognized directly in the ledger alongside `run_command`.
- Gate rules (`R1` through `R9`) and exceptions (`E1` through `E11`):
	- `R1_UNREAD_INSPECTED`: blocks when `inspected_files` lists a file never read in the session (newly created files via `write_file`/`write_to_file` count as read).
	- `R2_STALE_VERIFICATION`: blocks when code files were modified and no verification command ran after the last code write. Exempt for doc/asset-only edits (`E1`, `.md`, `.txt`, `.rst`, `.adoc`, `.svg`, image assets, `docs/`, `LICENSE`), or downgraded to warning when no test infrastructure exists and `not_applicable` with a concrete reason and non-empty `unverified_scope` are provided (`E2`).
	- `R3_CONCEALED_FAILURE`: blocks when any post-write verification failure remains unresolved by a subsequent passing run of the same command or covering segment.
	- `R4_UNREPORTED_MODIFIED`: blocks when a file modified in the turn and still dirty in Git is omitted from `modified_files` (reverted/clean files are exempt under `E5`).
	- `R5_FABRICATED_COMMAND`: blocks when a `verification_runs` entry claims `outcome: "pass"` with no matching post-write passing execution (supports shell segments, `run_command`, and `mcp_agy-fast_fast_run_checks` aliases/labels).
	- `R6_PHANTOM_MODIFIED`: warns when a claimed modified file is absent from both turn writes and Git dirty state, and blocks when no turn writes exist while Git is available.
	- `R7_HEDGE_DETECTED`: warns when `self_assessment` contains 2 or more hedging expressions (`scripts/governance/hedge-detector.mjs`) while effective `unverified_scope` is empty (filler entries such as `"없음"` or `"none"` are filtered out).
	- `R8_AUDIT_REJECTED` / `R8_AUDIT_ERROR`: blocks when a required `TIER_1` post-write `hstack-auditor` review rejects or errors/omits a verdict (`E9`/`E10` degrade to `PASS_WITH_AUDIT_DEGRADATION` after 2 rejections or 2 consecutive trailing errors with explicit `unverified_scope`).
	- `R9_PREFLIGHT_UNVOTED`: evaluated before `TIER_1` escalation whenever a `main` session modifies code in the same turn as a completed preflight challenge without a subsequent valid `ask_question` user vote. Unvoted `RETHINK` verdicts `BLOCK` (`REJECT`), while unvoted `CONDITIONAL`, `PROCEED`, `ERROR`, or `MISSING_VERDICT` challenges emit `WARN` (`PASS_WITH_WARNING`). Exception `E11` (aligned with `E7`) prevents permanent deadlock on the 4th attempt after 3 prior rejects when `unverified_scope` discloses the missing vote, without ever exempting `TIER_1` post-write `hstack-auditor` escalation.
	- Additional exceptions include session-missing skip (`SKIPPED_NO_SESSION`, `E8`), repeated-reject graceful degradation (`E7`), `auditor`/`challenger` session bypass, and subagent role isolation.

### Layer 3: isolation plane (opt-in adversarial preflight, independent auditing, and context handoff)

- Opt-in adversarial preflight challenge (`skills/hstack-preflight/SKILL.md`, `agents/hstack-challenger.md`):
	- Zero friction when not invoked. Supports three modes: `/hstack-preflight [proposal]` (default), `/hstack-preflight plan [proposal]` (design-only, zero file edits), and `/hstack-preflight strict [proposal]` (red-team hypothesis favoring rejection).
	- Flow: read relevant files and draft a 4-item neutral brief stripped of leading tone -> dispatch read-only `hstack-challenger` (`invoke_subagent`) for 4-axis `file:line` challenge (hidden assumptions, failure modes/blast radius, minimal/do-nothing baseline comparison, counter-architecture with trade-offs; ending strictly with `[사전검토 판정: 진행 가능]`, `[사전검토 판정: 조건부 진행]`, or `[사전검토 판정: 재설계 권고]`) -> present a comparison table and call built-in `ask_question` with 4 choices.
	- In non-interactive runs (`agy -p`) where `ask_question` returns an empty answer (`A1:` blank) or error, the skill outputs only the comparison table and 4 choices without editing files. Preflight never exempts `verify_completion` or `TIER_1` post-write `hstack-auditor` review.
- Risk-tiered independent code auditor (`agents/hstack-auditor.md`, `scripts/governance/risk-classifier.mjs`):
	- `classifyRisk` assigns `TIER_1` when a code change touches a sensitive path (`sensitive_path`, such as `auth`, `security`, `crypto`, `token`, `session`, `migrations`, `hooks.json`, `mcp_config.json`, `scripts/mcp/`, `scripts/governance/`), modifies 4 or more code files (`large_file_count`), or changes 150 or more code lines (`large_diff_lines`). All other changes are `TIER_0`.
	- On `TIER_1` code edits in `main` sessions with `auditEscalation: "auto"`, `verify_completion` returns `ESCALATE_AUDIT_REQUIRED` until a post-write `hstack-auditor` read-only review completes and ends with `[감사 판정: 통과]` or `[감사 판정: 반려]`.
	- `PreToolUse` (`scripts/pre-tool-gate.mjs`) intercepts `invoke_subagent` for `hstack-auditor`, `hstack-challenger`, and `hstack-worker` to inject Korean role labels, session role markers (`[hstack:독립감사]`, `[hstack:사전검토]`, `[hstack:격리작업]`), workspace path, and transcript anchors.
- Fact-distilled cross-session handoff (`skills/hstack-handoff/SKILL.md`, `agents/hstack-worker.md`, `scripts/governance/handoff-store.mjs`):
	- Eager MCP tool `mcp_hstack_gate_manage_handoff` (`manage_handoff`) supports `save`, `load`, and `list` actions per workspace key (`computeWorkspaceKey`), combining distilled facts (`objective`, `verified_facts`, `failed_approaches`, `remaining_tasks`, `open_risks`) with machine evidence (Git branch, HEAD, dirty files, read/written files, verification runs) and flagging stale working trees on load.
	- Context pollution tracking (`updateSessionPollutionState` in `scripts/post-invocation.mjs`) monitors `inputTokens`, failed executions in turn, and repeated single-file edit churn, appending a non-blocking `[컨텍스트 열화 주의]` notice to gate receipts when thresholds trip.

## Install and upgrade

### Fresh install

Install `hstack` from GitHub or a local checkout, then start a new Antigravity CLI session.

```sh
agy plugin install https://github.com/hs1662/thinking-korean
agy plugin install .
```

Run `/thinking` inside an Antigravity CLI session to view `thinking` traces.

### Upgrade from `thinking-korean`

Remove the legacy `thinking-korean` plugin first so duplicate hooks do not run, install `hstack`, and start a new `agy` session.

```sh
agy plugin uninstall thinking-korean
agy plugin install https://github.com/hs1662/thinking-korean
```

To upgrade an existing local `hstack` installation while preserving `plugin_data/hstack/` (`audit.jsonl`, `config.json`, handoff snapshots):

```sh
agy plugin uninstall hstack
agy plugin install /path/to/thinking-korean
```

Start a new `agy` session after every install or upgrade so updated hooks, rules, agents, skills, and MCP servers load cleanly.

## Configuration reference

`hstack` reads optional JSON settings from:

```text
$ANTIGRAVITY_APP_DATA_DIR/plugin_data/hstack/config.json
```

When `PLUGIN_DATA` or `HSTACK_DATA_DIR` is set, that directory takes precedence. Default app-data path on Linux is `~/.gemini/antigravity-cli/plugin_data/hstack/config.json`.

### Supported `config.json` keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `schemaRegister` | `"neutral" \| "audit"` | `"neutral"` | Selects tool schema and receipt copy register. |
| `auditEscalation` | `"auto" \| "manual" \| "off"` | `"auto"` | Controls `TIER_1` independent auditor escalation. `"auto"` enforces escalation on `TIER_1` edits in `main` sessions; `"manual"` and `"off"` skip automatic escalation. |
| `riskThresholds.minCodeFiles` | positive integer | `4` | Minimum modified code files to classify as `TIER_1` (`large_file_count`). |
| `riskThresholds.minChangedLines` | positive integer | `150` | Minimum added plus deleted code lines to classify as `TIER_1` (`large_diff_lines`). |
| `sensitivePatterns` | `string[]` (max 50) | Built-in list | Optional custom case-insensitive regex strings overriding default sensitive path patterns. |
| `pollutionThresholds.inputTokensWarning` | integer | `120000` | Input token threshold for `pollutionAlert`. |
| `pollutionThresholds.failedExecutionsInTurn` | integer | `4` | Failed execution count per turn threshold for `pollutionAlert`. |
| `pollutionThresholds.repeatedFileEditChurn` | integer | `5` | Repeated edits to a single file per turn threshold for `pollutionAlert`. |

Example `config.json`:

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

### Environment variables and precedence

Environment variables override `config.json`, which overrides built-in defaults.

1. `HSTACK_SCHEMA_REGISTER` (`"neutral"` or `"audit"`) > `config.json` `schemaRegister` > `"neutral"`.
2. `HSTACK_AUDIT_ESCALATION` (`"auto"`, `"manual"`, or `"off"`) > `config.json` `auditEscalation` > `"auto"`.

## Usage guide

### Adversarial preflight review (`/hstack-preflight`)

Use `/hstack-preflight` before non-trivial refactors or architectural changes when you want code-grounded pushback instead of sycophantic agreement.

- `/hstack-preflight [proposal]` (default): builds a neutral 4-item brief, delegates read-only 4-axis review to `hstack-challenger`, summarizes trade-offs in a comparison table, and runs a 4-choice `ask_question` vote before editing. In non-interactive runs (`agy -p`) where `ask_question` returns empty or errors, it prints the comparison table and choices without modifying files.
- `/hstack-preflight plan [proposal]`: design-only review; strictly forbids file edits.
- `/hstack-preflight strict [proposal]`: red-team review instructing `hstack-challenger` to default toward rejecting the proposal unless code evidence holds up.

### Context handoff (`/hstack-handoff`)

Use `/hstack-handoff` to distill and transfer session state without carrying raw conversation bloat.

- `/hstack-handoff save` (default): calls `manage_handoff(action: "save")` to store verified facts, failed approaches, remaining tasks, open risks, and machine evidence as a workspace snapshot.
- `/hstack-handoff load` or `/hstack-handoff load <snapshot_id>`: calls `manage_handoff(action: "load")` to restore the latest or named snapshot and warn if Git HEAD or dirty files changed since saving.
- `/hstack-handoff list`: calls `manage_handoff(action: "list")` to inspect recent snapshots for the current workspace.
- `/hstack-handoff delegate`: saves or loads the latest snapshot and dispatches `hstack-worker` (`invoke_subagent`) with the distilled handoff brief and scoped verification target.

### Audit log summary CLI (`scripts/audit-report.mjs`)

Inspect operational gate metrics across 7 sections from `audit.jsonl`: `[1]` overall summary, `[2]` period reject trend, `[3]` `R1~R9` rule violation/warning distribution (including `R9_PREFLIGHT_UNVOTED`), `[4]` Tier 1 independent audit stats, `[5]` context pollution alerts and unverified scope, `[6]` local scan latency (`ledgerScanMs`, `gitScanMs`), and `[7]` adversarial preflight challenge summary (turn-deduplicated count, verdict distribution, vote completion rate, and `R9_PREFLIGHT_UNVOTED` blocks/warnings).

```sh
node ./scripts/audit-report.mjs
node ./scripts/audit-report.mjs --days 7
node ./scripts/audit-report.mjs --since 2026-11-20 --group-by week
node ./scripts/audit-report.mjs --days 7 --json
node ./scripts/audit-report.mjs --file /path/to/audit.jsonl
```

Default file resolution checks `--file`, `$PLUGIN_DATA/audit.jsonl`, `$HSTACK_DATA_DIR/audit.jsonl`, `$ANTIGRAVITY_APP_DATA_DIR/plugin_data/hstack/audit.jsonl`, `~/.gemini/antigravity-cli/plugin_data/hstack/audit.jsonl`, and `resolvePluginDataDir()/audit.jsonl` in order.

## Verification and tests

Run the unit test suite, strict plugin manifest validation, and isolated live checks from the repository root.

```sh
node --test test/*.test.mjs
agy plugin validate --strict --json .
node ./test/verify-live.mjs --models gemini-4-neon-xhigh
```

`test/verify-live.mjs` executes each scenario in an isolated temporary `HOME` and app-data directory so global plugins cannot interfere and cleans up temporary logs on exit.

### Measured baseline (v2.2.0)

- Unit and integration suite: `node --test test/*.test.mjs` — **66 suites / 262 tests pass (`fail 0`)**, covering analyzer, English-request exemptions, transcript hooks, fact ledger (including `challenger` role, `turnPreflightChallenges`, `turnUserVotes`, and 5MB median scan `<= 100ms`), completion gate (`R1` through `R9`, `E1` through `E11`), risk classification and independent audit, handoff store and MCP stdio roundtrip, and `audit-report.mjs` (`[1]`–`[7]`).
- Strict manifest validation: `agy plugin validate --strict --json .` exits `0` with `"findings": []` and `components: { agents: 3, hooks: 1, mcpServers: 1, rules: 1, sidecars: 0, skills: 2 }`.
- Isolated live governance suite (`test/verify-live.mjs`, `L1`–`L11` on `gemini-4-neon-xhigh`): covers golden path (`L1`), unverified reject recovery (`L2`), Stop bypass recovery (`L3`), read-only frictionless (`L4`), Tier 1 audit pass/reject recovery (`L5`/`L6`), cross-session handoff (`L7`), low-risk non-escalation (`L8`), `/hstack-preflight plan` anti-sycophancy challenge (`L9`), headless `/hstack-preflight` no-silent-edit fallback (`L10`), and normal refactor zero-preflight friction (`L11`), all with `hookcaller` panics `0` and weighted Korean thinking `100.00%`.

See [Publishing guide](docs/PUBLISHING.md) for releases and [MIT License](LICENSE) for licensing.
