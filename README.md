# Thinking Korean

[한국어](README.ko.md)

`thinking-korean` keeps Antigravity CLI `thinking` traces and responses in natural conversational Korean with an always-on Korean rule plus `PostInvocation` and `Stop` drift-recovery hooks. It requires Node.js 18 or newer and has zero npm dependencies.

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

The plugin pairs one always-on rule file with two lifecycle hooks (`PostInvocation` and `Stop`).

- `rules/AGENTS.md` loads into `<user_rules>` as a Korean-only rule file. It tells the model to think and reply in natural conversational Korean sentences, as if talking directly with the user. It puts an explicit Korean summary-language declaration at the start of every reasoning paragraph and keeps reasoning concise (6 to 8 paragraphs, 3 to 4 sentences each) so server-side thought summarizers stay in Korean across every chunk. File names, paths, code identifiers, commands, proper nouns, and everyday English technical terms stay natural inside Korean sentences without forced transliteration, while English sentences, clauses, and paragraphs are disallowed.
- `PostInvocation` in `hooks.json` runs `scripts/post-invocation.mjs` after model invocation and tool execution complete to scan `transcript_full.jsonl` and inspect the latest `PLANNER_RESPONSE`. The analyzer (`scripts/analyzer.mjs`) permits embedded 1-to-3-word non-prose English technical terms inside Korean sentences alongside code, paths, and identifiers, while catching English sentences, contractions, 4-plus-word English runs, and English paragraphs. When drift appears, the hook injects a non-blocking Korean `[한국어사고:영어이탈]` `systemMessage` with stateless recovery-aware backoff:
  - Recovery resets failure counts and cooldown immediately.
  - Persistent `thinking`-only drift backs off and stops after a consecutive-failure cap (`2` unrecovered injections) until Korean `thinking` resumes, preventing infinite context pollution on stubborn models or summarizers.
  - User-facing `content` drift uses an independent budget, and explicit English or translation requests in `USER_INPUT` exempt `content` while keeping `thinking` in Korean.
- `Stop` in `hooks.json` runs `scripts/stop.mjs` before a normal `NO_TOOL_CALL` turn ends. If final user `content` drifted into English without an explicit English or translation request, it returns `decision: "continue"` once to recover the response in Korean. It passes through when `continuationActive` is true, when termination is abnormal, or when `content` is already Korean.
- Both hooks fail open with `{}` on read, parse, or event errors.

## Model behavior

Plugins cannot rewrite tokens already streamed or set a provider thought-language parameter, so hook recovery takes effect on the next model call. Isolated live runs measured these results:

- `gemini-4-neon-xhigh` passed all 4 isolated cases (`korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, and `explicit-translation`) across two consecutive runs on the final code with zero hook injections and `100.0%` Hangul thinking on every step (`84.8%` to `96.2%` Korean content, translation exemption passed), while keeping identifiers such as `src/analyzer.mjs`, `docs/SKILL.md`, and `analyzeField` verbatim.
- `gemini-3.8-flash-high` also passed all 4 isolated cases across two consecutive runs on the final code with zero hook injections and `97.4%` to `100.0%` weighted Hangul thinking (`80.1%` to `99.2%` Korean content, translation exemption passed).
- `claude-opus-5-5-high` passed `korean-reasoning` (`94.0%` Hangul thinking, `92.9%` content) and `tool-code-analysis` (`91.1%` Hangul thinking, `94.5%` content) with zero hook injections under the prior natural Korean rule revision; live re-verification against the final every-paragraph lock rule and `Stop` hook is pending quota reset (`429`).
- `gpt-oss-120b-medium` keeps most internal thinking in English; the `thinking`-only cap avoids repeated context pollution.

## Verify

Run the unit tests, strict plugin validation, and isolated live checks from the repository root.

```sh
node --test test/thinking-korean.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

`test/verify-live.mjs` runs each case in an isolated temporary `HOME` and app-data directory so globally installed plugins cannot interfere, cleans up temporary brain logs automatically, and supports these flags:

```sh
node test/verify-live.mjs \
  --models gemini-4-neon-xhigh,claude-opus-5-5-high \
  --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation \
  --timeout 180 \
  --keep-logs
```

See the [Publishing guide](docs/PUBLISHING.md) for releases and the [MIT License](LICENSE) for licensing.
