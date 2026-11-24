# Thinking Korean

[한국어](README.ko.md)

`thinking-korean` keeps Antigravity CLI `thinking` traces and responses in Korean with an always-on pure-Korean thinking rule and a `PostInvocation` drift-recovery hook. It requires Node.js 18 or newer and has zero npm dependencies.

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

The plugin pairs one always-on rule file with one `PostInvocation` hook script.

- `rules/AGENTS.md` loads into `<user_rules>` as a pure-Korean rule that separates internal reasoning from final output. Inside internal thinking and thought summaries, English letters are banned (`No-ASCII-in-CoT`); file names, paths, identifiers, and technical terms are translated or transliterated into Korean so server-side thought summarizers stay in Korean. Exact original code blocks, inline code, file paths, URLs, identifiers, CLI flags, verbatim error logs, and explicit translation targets remain verbatim only in tool call arguments and final user responses.
- `hooks.json` runs `scripts/post-invocation.mjs` on `PostInvocation` (after model invocation and tool execution complete) to scan `transcript_full.jsonl` and inspect the latest `PLANNER_RESPONSE`. When English drift appears, it injects a non-blocking pure-Korean `[한국어사고:영어이탈]` `systemMessage` with stateless recovery-aware backoff:
  - Recovery resets failure counts and cooldown immediately.
  - Persistent `thinking`-only drift backs off and stops after a consecutive-failure cap (`2` unrecovered injections) until Korean `thinking` resumes, preventing infinite context pollution on stubborn models or summarizers.
  - User-facing `content` drift uses an independent budget, and explicit English or translation requests in `USER_INPUT` exempt `content` while keeping `thinking` in Korean.
  - On read, parse, or event errors, the hook fails open with `{}`.

## Model behavior

Plugins cannot rewrite tokens already streamed or set a provider thought-language parameter, so hook recovery takes effect on the next model call. Isolated live runs measured these results:

- `claude-opus-5-5-high` maintains `100%` Korean thinking (`0` drifted steps, `0` hook injections) on pure reasoning and heavy English skill + code tool turns.
- `gemini-4-neon-xhigh` improved on controlled heavy-English multi-step tool runs from `8.3%` Korean thinking steps (`0.1515` average Hangul ratio) under the previous identifier-allowing rule to `62.5%` Korean steps (`0.7414` average Hangul ratio) with the pure-Korean internal thinking rule, reaching `100%` across `4/4` steps and recovering under heavy English stress (`0.00` to `0.79` after one `systemMessage` injection). Gemini's server-side thought summarizer remains probabilistic across runs, so the `thinking`-only consecutive-failure cap limits repeated injections when a turn does not recover.
- `gemini-4-carbon-high` and `gemini-3.8-flash-high` reach `90%` to `100%` Korean thinking on pure reasoning, with the same server-side summarizer variability on English-heavy tool turns.
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
