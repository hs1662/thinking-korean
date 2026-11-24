# Thinking Korean

Read the Korean guide in [한국어 문서](README.ko.md).

`thinking-korean` is an Antigravity plugin that keeps internal thinking traces (`thinking`) and final responses (`content`) in Korean. It combines an always-on rule in `rules/AGENTS.md` with a stateless `PostInvocation` drift-recovery hook defined in `hooks.json` and executed by `scripts/post-invocation.mjs`. The plugin has zero runtime npm dependencies and requires Node.js 18 or newer.

## Installation and quickstart

Verify that you have Antigravity CLI (`agy`) and Node.js 18 or newer installed before you install the plugin.

1. Install from a local checkout or from GitHub.

   ```sh
   # Install from a local directory
   agy plugin install .

   # Install from GitHub
   agy plugin install https://github.com/hs1662/thinking-korean
   ```

2. Run `/thinking` inside an Antigravity CLI session so the terminal displays internal `thinking` traces alongside responses.
3. Validate a local checkout at any time with strict checks.

   ```sh
   agy plugin validate --strict .
   ```

You can turn the plugin off or back on without uninstalling it.

```sh
agy plugin disable thinking-korean
agy plugin enable thinking-korean
```

## How it works

`thinking-korean` uses two layers. The first layer prevents English drift at prompt time, and the second layer detects and corrects drift across multi-step tool loops.

### Always-on rule in `rules/AGENTS.md`

When `thinking-korean` is enabled, Antigravity merges `rules/AGENTS.md` into `<user_rules>`. The rule sets these requirements.

- Write all internal thinking (`thinking`), thought summaries, and final responses (`content`) in Korean through a bilingual English and Korean mandate that includes zero English example phrases.
- Keep original text only for code blocks, inline code, file paths, directory paths, URLs, code identifiers (`camelCase`, `snake_case`, `PascalCase`, constants), CLI commands, subcommands, flags, tool arguments, verbatim error quotes, and explicit user translation requests.
- Stop any English prose sentence that appears mid-thought and resume Korean on the next phrase.

### Stateless `PostInvocation` drift guard

`hooks.json` registers the `thinking-korean-drift-guard` hook on the `PostInvocation` event. After each model invocation, Antigravity runs `node ./scripts/post-invocation.mjs` with a 5-second timeout.

1. `scripts/post-invocation.mjs` reads `transcriptPath` from stdin JSON. When Antigravity passes compact `transcript.jsonl`, the script checks for a sibling `transcript_full.jsonl` first and falls back to `transcript.jsonl`.
2. `scripts/transcript.mjs` parses the JSONL steps through `parseTranscriptJsonl` and inspects only the latest `PLANNER_RESPONSE` step.
3. `scripts/analyzer.mjs` calls `extractNaturalText` on `thinking` and `content` separately to strip fenced code blocks, blockquotes, inline code, double-quoted strings, URLs, XML tags, file paths, CLI flags, dotted paths, and `snake_case`, `camelCase`, and `PascalCase` identifiers.
4. `analyzeField` checks the remaining natural-language prose against the threshold constants exported by `scripts/analyzer.mjs`.
5. When `evaluatePlannerResponse` detects drift, `decideHookAction` in `scripts/transcript.mjs` builds a single non-blocking `systemMessage` through `injectSteps`. The message starts with `DRIFT_MARKER` (`[thinking-korean:drift]`) and names only the drifted fields (`thinking`, `content`, or `thinking and content`).

`scripts/analyzer.mjs` exports these drift-detection constants.

| Constant | Value | Purpose |
| :--- | :--- | :--- |
| `MIN_NATURAL_CHARS` | `24` | Skips fields with fewer than 24 Hangul plus Latin characters (`insufficient`). |
| `MIN_LATIN_CHARS_FOR_DRIFT` | `16` | Requires at least 16 Latin characters before reporting drift. |
| `MIN_HANGUL_RATIO` | `0.45` | Flags whole-field `low_hangul_ratio` drift when the Hangul ratio is below `0.45`. |
| `SEGMENT_MIN_NATURAL_CHARS` | `40` | Minimum natural-language length for paragraph or line segment checks. |
| `SEGMENT_MAX_HANGUL_RATIO` | `0.25` | Flags `english_segment` drift when a qualifying segment has a Hangul ratio at or below `0.25`. |
| `ENGLISH_RUN_WORD_THRESHOLD` | `8` | Flags `english_run` drift when a paragraph contains 8 or more consecutive Latin prose words. |

The hook stores no state on disk. It derives idempotency and cooldown directly from the transcript.

- If a `SYSTEM_MESSAGE` step containing `[thinking-korean:drift]` already follows the latest `PLANNER_RESPONSE`, `decideHookAction` returns `already_covered` and emits `{}`.
- After an injection, `decideHookAction` suppresses repeated injections for `DEFAULT_COOLDOWN_INVOCATIONS = 2` planner responses (`cooldown_active`), then re-injects on the third planner response if drift continues.
- On malformed stdin, missing paths, unreadable transcripts, or unexpected errors, `scripts/post-invocation.mjs` fails open by printing `{}` and exiting with code `0`.

## Known platform behavior and limitations

Antigravity plugins cannot rewrite tokens already streamed to the terminal, and they cannot set a provider-level thought-language API parameter. The `PostInvocation` hook injects a `systemMessage` after a drifted invocation finishes, so recovery takes effect on the next model call rather than changing text that already appeared.

Live runs of `test/verify-live.mjs` measured the following model behavior.

| Model | Pure Korean reasoning | English-code tool analysis | Notes |
| :--- | :--- | :--- | :--- |
| `claude-opus-5-5-high` | Passed on the first step with `94.5%` Hangul thinking and `0` hook injections. | Recovered to `94.3%` Hangul thinking after `1` `PostInvocation` drift injection. | Follows both `<user_rules>` and `[thinking-korean:drift]` recovery reliably. |
| `gemini-4-neon-xhigh`, `gemini-4-carbon-high`, `gemini-3.8-flash-high` | Produced `90%` to `100%` Korean thinking. | Can still emit English thought summaries before or despite hook recovery. | Gemini generates `thinking` through a server-side thought summarizer. |
| `gpt-oss-120b-medium` | Keeps most internal chain-of-thought in English. | Keeps most internal chain-of-thought in English. | Internal reasoning stays mostly English even with `<user_rules>` active. |

## Repository layout

The repository tracks 14 files. Run `git ls-files` to regenerate the list.

| Path | Role |
| :--- | :--- |
| `.gitignore` | Ignores local scratch files (`todo.md`, `.audit/`, `node_modules/`, `.DS_Store`). |
| `LICENSE` | MIT license text. |
| `README.md` | English documentation for GitHub and Antigravity Marketplace. |
| `README.ko.md` | Korean documentation. |
| `assets/logo.svg` | 256x256 square plugin logo with outer padding. |
| `docs/PUBLISHING.md` | How-to guide for GitHub releases and Antigravity Marketplace submission. |
| `hooks.json` | Registers the `PostInvocation` hook command and timeout. |
| `plugin.json` | Antigravity plugin manifest. |
| `rules/AGENTS.md` | Always-on bilingual Korean thinking and response rule. |
| `scripts/analyzer.mjs` | Natural-text extraction and English-drift threshold analyzer. |
| `scripts/post-invocation.mjs` | Executable `PostInvocation` CLI entrypoint and transcript loader. |
| `scripts/transcript.mjs` | JSONL transcript parser, marker idempotency, cooldown reducer, and message builder. |
| `test/thinking-korean.test.mjs` | 22 unit and subprocess integration tests. |
| `test/verify-live.mjs` | Live multi-model verification script against `agy`. |

## Verification

Run the unit and hook subprocess test suite, which executes 22 tests across the analyzer, transcript reducer, and `PostInvocation` CLI adapter.

```sh
node --test test/thinking-korean.test.mjs
```

Validate the plugin manifest, logo, rule layout, and hook definition with strict mode enabled.

```sh
agy plugin validate --strict .
```

Run live verification against real Antigravity models. The script stages the plugin into a temporary workspace under `.agents/plugins/thinking-korean`, runs the `korean-reasoning` and `tool-code-analysis` cases, and prints a JSON report from `transcript_full.jsonl`.

```sh
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

## Publishing and license

Follow the [Publishing guide](docs/PUBLISHING.md) to validate, tag a GitHub release, and submit `thinking-korean` to the Antigravity Marketplace.

This project is released under the [MIT License](LICENSE).
