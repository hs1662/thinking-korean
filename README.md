# Thinking Korean

[한국어](README.ko.md)

`thinking-korean` keeps Antigravity CLI `thinking` traces and responses in Korean with an always-on rule and a `PostInvocation` drift-recovery hook. It requires Node.js 18 or newer and has zero npm dependencies.

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

The plugin uses one rule file and one hook script.

- `rules/AGENTS.md` loads into `<user_rules>` as a bilingual Korean-only thinking and response rule. Code, file paths, identifiers, CLI flags, URLs, verbatim error quotes, and explicit translation targets stay in their original text.
- `hooks.json` runs `scripts/post-invocation.mjs` after each model invocation to inspect the latest `PLANNER_RESPONSE` in `transcript_full.jsonl`. If English prose appears in `thinking` or `content`, the hook injects one non-blocking `[thinking-korean:drift]` `systemMessage` with a stateless 2-invocation cooldown. On errors, it fails open with `{}`.

## Model behavior

Plugins cannot rewrite tokens already streamed or set a provider thought-language parameter, so hook recovery applies to the next model call. Live runs with `test/verify-live.mjs` measured these results.

- `claude-opus-5-5-high` keeps pure reasoning in Korean from step 1 at `94.5%` Hangul. On English-code tool turns, it recovers to `94.3%` Hangul after 1 hook injection.
- `gemini-4-neon-xhigh`, `gemini-4-carbon-high`, and `gemini-3.8-flash-high` reach `90%` to `100%` Korean thinking on pure reasoning. On English-code tool turns, Gemini's server-side thought summarizer can still emit English summaries.
- `gpt-oss-120b-medium` keeps most internal thinking in English.

## Verify

Run the unit tests, strict plugin validation, and live model checks from the repository root.

```sh
node --test test/thinking-korean.test.mjs
agy plugin validate --strict .
node test/verify-live.mjs --models gemini-4-neon-xhigh,claude-opus-5-5-high
```

See the [Publishing guide](docs/PUBLISHING.md) for releases and the [MIT License](LICENSE) for licensing.
