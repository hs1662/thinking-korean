# Thinking Korean

[한국어](README.ko.md)

`thinking-korean` keeps Antigravity CLI `thinking` traces, user-facing tool UI labels (step checklists, tool summaries, subagent roles, and prompts), and responses in natural conversational Korean with an always-on Korean rule plus `PreToolUse`, `PostInvocation`, and `Stop` drift-recovery hooks. It requires Node.js 18 or newer and has zero npm dependencies.

## Install

Install the plugin from GitHub or from a local checkout.

```sh
agy plugin install https://github.com/hs1662/thinking-korean
agy plugin install .
```

Run `/thinking` inside an Antigravity CLI session to display `thinking` traces.

Turn the plugin off or back on at any time with these commands.

```sh
agy plugin disable thinking-korean
agy plugin enable thinking-korean
```

## How it works

The plugin pairs one always-on rule file with three lifecycle hooks (`PreToolUse`, `PostInvocation`, and `Stop`).

- `rules/AGENTS.md` loads into `<user_rules>` as a pure-Korean rule file. It anchors Korean as the model's sole first and native language for internal reasoning, thought summaries, final responses, and all user-visible tool UI labels. It places an explicit Korean summary-language declaration at the start of every reasoning paragraph, keeps internal reasoning compressed to 2 to 3 short paragraphs (at most 2 sentences per paragraph, 6 sentences total) without code snippets, parenthetical English glosses, numbered or bulleted lists, or long draft breakdowns, and moves detailed technical walkthroughs directly to tool calls and the final reply so server-side thought summarizers neither flip mid-chunk on long audits nor leak meta-instructions on short confirmation steps. Final replies keep file names, paths, code identifiers, commands, proper nouns, and everyday English technical terms verbatim inside natural Korean sentences while disallowing English sentences and clauses.
- `PreToolUse` in `hooks.json` runs `scripts/pre-tool-use.mjs` before pure UI display tools (`update_steps`, `ask_question`, `todo_write`, `task_create`, `task_update`, `update_plan`). If step titles or prompt labels drift into English, it returns `decision: "deny"` with a Korean correction reason before English checklists render on screen, capped at one stateless retry per turn so execution never loops.
- `PostInvocation` in `hooks.json` runs `scripts/post-invocation.mjs` after model invocation and tool execution complete to scan `transcript_full.jsonl` and inspect the latest `PLANNER_RESPONSE` (`thinking`, `content`, and user-facing `tool_calls` UI text). The analyzer (`scripts/analyzer.mjs`) permits embedded 1-to-3-word non-prose English technical terms inside Korean sentences alongside closed code fences, paths, identifiers, and the single-line English boilerplate injected by the server-side thought summarizer in `thinking`, while catching English sentences (including 4-to-7-word inline English sentences appended to Korean lines), contractions, 4-plus-word English runs, English paragraphs, unclosed-fence prose leaks, and English UI labels (including Title Case task summaries and subagent roles). When drift appears, the hook injects a non-blocking Korean `[한국어사고:영어이탈]` `systemMessage` with stateless recovery-aware backoff:
  - Recovery resets failure counts and cooldown immediately.
  - Persistent `thinking`-only or `ui`-only drift backs off and stops after a consecutive-failure cap (`2` unrecovered injections) until Korean output resumes, preventing infinite context pollution on stubborn models or summarizers.
  - User-facing `content` drift uses an independent budget, and explicit foreign-language or translation requests in `USER_INPUT` (including dotted filenames/versions, Japanese/Chinese, and clause-scoped negations or Korean-reasoning clauses) exempt `content` while keeping `thinking` and step checklists in Korean.
- `Stop` in `hooks.json` runs `scripts/stop.mjs` before a normal `NO_TOOL_CALL` turn ends. If final user `content` drifted into English without an explicit English or translation request, it returns `decision: "continue"` once to recover the response in Korean. Earlier `thinking`-only or `ui`-only markers in the same turn do not suppress `Stop` recovery, and it passes through when `continuationActive` is true, when termination is abnormal, or when `content` is already Korean.
- Fail-open contract: `PreToolUse` returns `{"decision":"allow"}` both when it allows a call and on read, parse, or unexpected errors. `PostInvocation` and `Stop` return `{}` when they take no action and on the same errors.

Recovery details:

- Injected messages start with a structured marker that names the drifted fields, such as `[한국어사고:영어이탈][대상:추론+응답]` (`추론` = `thinking`, `응답` = `content`, `화면` = `ui`). The plain `[한국어사고:영어이탈]` marker and the legacy `[thinking-korean:drift]` marker are still recognized.
- After a `PreToolUse` denial, `PostInvocation` excludes only the denied tool call indexes so sibling non-denied tool calls with English UI text (such as `run_command` `toolSummary` or `invoke_subagent` `Role`) are still caught.
- Korean recovery resets the retry budget: a Korean call of the same UI tool that goes through resets the `PreToolUse` retry count, and Korean output resets the `PostInvocation` failure count and cooldown for that field.
- UI labels made only of short technical proper names (up to 4 Title Case words, acronyms, or versions), such as `React Router` or `Docker Compose`, are allowed and not treated as English drift.

Module layout:

- `scripts/analyzer.mjs` is the analyzer entry point and re-exports the modules in `scripts/analyzer/` (`constants.mjs`, `lexicon.mjs`, `lines.mjs`, `prose-rules.mjs`, `stripper.mjs`, `ui.mjs`).
- `scripts/transcript.mjs` is the transcript entry point and re-exports the modules in `scripts/transcript/` (`steps.mjs`, `english-request.mjs`, `ui-extractor.mjs`, `markers.mjs`, `trackers.mjs`, `decide-post.mjs`, `decide-pre-tool.mjs`, `decide-stop.mjs`).
- `scripts/hook-io.mjs` holds the shared stdin, transcript reading, and JSON output code used by the hook entry points `scripts/pre-tool-use.mjs`, `scripts/post-invocation.mjs`, and `scripts/stop.mjs`.

## Model behavior

Plugins cannot rewrite tokens already streamed or set a provider thought-language parameter, so hook recovery takes effect on the next model call. Isolated live runs measured these results:

- `gemini-4-neon-xhigh` (current code) passed all 5 isolated cases (`korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, `explicit-translation`, and `todo-checklist`) with `driftInjections: 0`, `preToolDenials: 0`, and `93.65%` to `100.0%` weighted Hangul thinking. `explicit-translation` reported `contentExemptionPassed: true`, and `todo-checklist` actually executed `update_steps` (`requiredToolsExecuted: { update_steps: true }`). Command: `node test/verify-live.mjs --models gemini-4-neon-xhigh --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation,todo-checklist --timeout 180`.

The results below come from earlier runs on a previous code revision with the 4-case set (no `todo-checklist`) and have not been re-run on the current code:

- `gemini-3.8-flash-high` passed all 4 isolated cases across two consecutive runs with zero hook injections and `97.4%` to `100.0%` weighted Hangul thinking (`80.1%` to `99.2%` Korean content, translation exemption passed).
- `claude-opus-5-5-high` passed `korean-reasoning` (`94.0%` Hangul thinking, `92.9%` content) and `tool-code-analysis` (`91.1%` Hangul thinking, `94.5%` content) with zero hook injections under the prior natural Korean rule revision; live re-verification against the final every-paragraph lock rule and `Stop` hook is pending quota reset (`429`).
- `gpt-oss-120b-medium` keeps most internal thinking in English; the `thinking`-only cap avoids repeated context pollution.

## Verify

Run the unit tests, strict plugin validation, and isolated live checks from the repository root.

```sh
node --test test/*.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

`test/verify-live.mjs` runs each case in an isolated temporary `HOME` and app-data directory so globally installed plugins cannot interfere, cleans up temporary brain logs automatically, and supports these flags:

```sh
node test/verify-live.mjs \
  --models gemini-4-neon-xhigh,claude-opus-5-5-high \
  --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation,todo-checklist,deep-code-audit \
  --timeout 240 \
  --keep-logs
```

See the [Publishing guide](docs/PUBLISHING.md) for releases and the [MIT License](LICENSE) for licensing.
