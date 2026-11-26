# Publish hstack to GitHub and Antigravity Marketplace

Return to the [English README](../README.md) or [Korean README](../README.ko.md) for plugin architecture and usage details.

Use this guide to verify the repository before a release, push tags to GitHub, and submit updates to the Antigravity Marketplace.

## Bundled components

Confirm that `plugin.json` and the repository layout expose these components at version `2.2.0`:

- `rules` (`1`): `rules/AGENTS.md` (pure Korean, zero ASCII letters)
- `hooks` (`1`): `hstack-guard` in `hooks.json` (`PreToolUse`, `PostInvocation`, and `Stop`)
- `mcpServers` (`1`): `gate` in `mcp_config.json` (`scripts/mcp/server.mjs`, exposing eager tools `verify_completion` and `manage_handoff`; zero new eager tools in `v2.2.0`)
- `agents` (`3`): `agents/hstack-auditor.md`, `agents/hstack-worker.md`, and `agents/hstack-challenger.md`
- `skills` (`2`): `skills/hstack-handoff/SKILL.md` (`hstack-handoff`) and `skills/hstack-preflight/SKILL.md` (`hstack-preflight`)
- `assets`: `assets/logo.svg` (`256x256` square canvas with rounded badge padding)

## Pre-publish validation checklist

Run every required check from the repository root before you push `main` or a release tag.

1. Run the unit and contract test suite and confirm zero failures (v2.2.0 baseline: 66 suites / 262 tests).

   ```sh
   node --test test/*.test.mjs
   ```

2. Run strict Antigravity plugin validation and confirm exit code `0` with `"findings": []` and `components: { agents: 3, hooks: 1, mcpServers: 1, rules: 1, sidecars: 0, skills: 2 }`.

   ```sh
   agy plugin validate --strict --json .
   ```

3. Verify that all executable scripts have mode `100755` in the git index.

   ```sh
   git ls-files -s scripts/pre-tool-use.mjs scripts/pre-tool-gate.mjs scripts/post-invocation.mjs scripts/stop.mjs scripts/mcp/server.mjs scripts/audit-report.mjs test/verify-live.mjs
   ```

   If any entry shows `100644`, mark it executable in the working tree and index, then commit the mode change.

   ```sh
   chmod +x scripts/pre-tool-use.mjs scripts/pre-tool-gate.mjs scripts/post-invocation.mjs scripts/stop.mjs scripts/mcp/server.mjs scripts/audit-report.mjs test/verify-live.mjs
   git update-index --chmod=+x scripts/pre-tool-use.mjs scripts/pre-tool-gate.mjs scripts/post-invocation.mjs scripts/stop.mjs scripts/mcp/server.mjs scripts/audit-report.mjs test/verify-live.mjs
   ```

4. Confirm that `assets/logo.svg` uses `viewBox="0 0 256 256"` and outer padding (`x="26" y="26" width="204" height="204"`).
5. Confirm that `"version"` in `plugin.json`, `SERVER_INFO.version` in `scripts/mcp/server.mjs`, `README.md`, and `README.ko.md` match the target semantic version (`2.2.0`).
6. Confirm that no untracked or temporary files are staged, and that all modules under `rules/`, `agents/`, `skills/`, and `scripts/` are tracked.

   ```sh
   git status --short
   git ls-files rules/ agents/ skills/ scripts/
   ```

7. When you change `rules/AGENTS.md`, `scripts/analyzer/`, `scripts/transcript/`, or governance hooks, run the isolated live verification script (`L1`–`L11`) as needed.

   ```sh
   node ./test/verify-live.mjs
   ```

8. Review local audit telemetry (sections `[1]`–`[7]`, including `[3]` `R1~R9`, `[6]` scan latency, and `[7]` preflight summary) with the zero-dependency report CLI when inspecting operational metrics.

   ```sh
   node ./scripts/audit-report.mjs
   ```

## Confirm required manifest fields

Verify that `plugin.json` contains every required Antigravity Marketplace field before you publish.

| Field | Current value | Requirement |
| :--- | :--- | :--- |
| `name` | `"hstack"` | Lowercase plugin slug. |
| `displayName` | `"hstack"` | Human-readable title shown in the Marketplace listing. |
| `description` | One-sentence summary | Clear statement of what the plugin does. |
| `version` | `"2.2.0"` | Semantic version matching the GitHub release tag. |
| `logo` | `"assets/logo.svg"` | Relative path to a 1:1 square icon with padding. |
| `license` | `"MIT"` | License identifier matching `LICENSE`. |
| `homepage` | `"https://github.com/hs1662/thinking-korean"` | Public repository URL. |
| `repository` | `"https://github.com/hs1662/thinking-korean"` | Public GitHub repository URL. |
| `suggestedPrompts` | 3 Korean prompts | Example prompts displayed on the Marketplace detail page. |
| `author` | `{ "name": "hs1662", "url": "https://github.com/hs1662" }` | Author name and `https://` profile URL. |

## Push to GitHub and validate remotely

1. Create an annotated tag that matches `"version"` in `plugin.json`.

   ```sh
   git tag -a v2.2.0 -m "Release hstack v2.2.0"
   ```

2. Push `main` and the release tag with a standard fast-forward push.

   ```sh
   git push origin main v2.2.0
   ```

3. Validate the published GitHub repository directly with Antigravity CLI and confirm exit code `0` with `"findings": []`.

   ```sh
   agy plugin validate --strict --json https://github.com/hs1662/thinking-korean
   ```

4. Optional: create a GitHub Release for the tag.

   ```sh
   gh release create v2.2.0 --title "hstack v2.2.0" --generate-notes
   ```

## Upgrade from `thinking-korean`

Existing `thinking-korean` users must uninstall the legacy plugin first so duplicate hooks do not run, then install `hstack` and start a new `agy` session.

```sh
agy plugin uninstall thinking-korean && agy plugin install https://github.com/hs1662/thinking-korean
agy plugin list --json
```

## Submit to the Antigravity Marketplace

1. Open the [Antigravity Marketplace intake form](https://forms.gle/2EX5RFYPoJe1UgxR9).
2. Enter `https://github.com/hs1662/thinking-korean` as the repository URL and match the submitted version to `"version"` in `plugin.json` (`2.2.0`).
3. Confirm that `plugin.json`, `hooks.json`, `mcp_config.json`, `rules/AGENTS.md`, `agents/`, `skills/`, `scripts/`, `assets/logo.svg`, `README.md`, and `README.ko.md` are committed on `main` and pass `agy plugin validate --strict --json https://github.com/hs1662/thinking-korean`.
4. Rerun `node --test test/*.test.mjs` and `agy plugin validate --strict --json .` before you push any follow-up commits.
