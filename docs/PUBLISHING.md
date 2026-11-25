# Publish thinking-korean to GitHub and Antigravity Marketplace

Return to the [English README](../README.md) or [Korean README](../README.ko.md) for plugin architecture and usage details.

This guide covers pre-publish checks, GitHub repository releases, and submission to the Antigravity Marketplace.

## Pre-publish validation checklist

Complete every check from the repository root before you push a release tag.

1. Run the unit and hook subprocess test suite and verify all tests pass.

   ```sh
   node --test test/*.test.mjs
   ```

2. Run strict Antigravity plugin validation and verify exit code `0` with `"findings": []`.

   ```sh
   agy plugin validate --strict --json .
   ```

3. Verify executable scripts (`scripts/pre-tool-use.mjs`, `scripts/post-invocation.mjs`, `scripts/stop.mjs`, and `test/verify-live.mjs`) have executable mode `100755` in the git index (on-disk group/other bits depend on your local `umask` and are not tracked by git).

   ```sh
   git ls-files -s scripts/pre-tool-use.mjs scripts/post-invocation.mjs scripts/stop.mjs test/verify-live.mjs
   ```

   If any entry shows `100644`, mark it executable in the working tree and git index, then commit the mode change:

   ```sh
   chmod +x scripts/pre-tool-use.mjs scripts/post-invocation.mjs scripts/stop.mjs test/verify-live.mjs
   git update-index --chmod=+x scripts/pre-tool-use.mjs scripts/post-invocation.mjs scripts/stop.mjs test/verify-live.mjs
   ```

4. Verify `assets/logo.svg` has a 1:1 `256x256` canvas (`viewBox="0 0 256 256"`) and outer padding around the rounded badge (`x="26" y="26" width="204" height="204"`).
5. If this is a new release after `1.0.0`, update `"version"` in `plugin.json` using semantic versioning (`MAJOR.MINOR.PATCH`).
6. If you changed `rules/AGENTS.md` or any script under `scripts/`, run the isolated live check with all 5 cases and confirm every case passes (`korean-reasoning`, `tool-code-analysis`, `heavy-english-skill-tools`, `explicit-translation`, and `todo-checklist`). Also confirm `contentExemptionPassed: true` for `explicit-translation` and `requiredToolsExecuted: { update_steps: true }` for `todo-checklist`.

   ```sh
   node test/verify-live.mjs --models gemini-4-neon-xhigh --cases korean-reasoning,tool-code-analysis,heavy-english-skill-tools,explicit-translation,todo-checklist --timeout 180
   ```

7. Verify the split modules and the new hook files are tracked and committed. Each path must appear in `git ls-files`, and `git status --short` must print nothing for them.

   ```sh
   git ls-files scripts/analyzer/ scripts/transcript/ scripts/hook-io.mjs scripts/pre-tool-use.mjs
   git status --short scripts/analyzer/ scripts/transcript/ scripts/hook-io.mjs scripts/pre-tool-use.mjs
   ```

   If any path is missing or shows `??`, add it by name and commit it before tagging.

   ```sh
   git add -- scripts/analyzer/ scripts/transcript/ scripts/hook-io.mjs scripts/pre-tool-use.mjs
   ```

## Confirm required manifest fields

Verify that `plugin.json` contains all fields required by Antigravity Marketplace reviewers before you submit.

| Field | Current value | Requirement |
| :--- | :--- | :--- |
| `name` | `"thinking-korean"` | Lowercase slug that matches the plugin directory name. |
| `displayName` | `"Thinking Korean"` | Human-readable title shown in the Marketplace listing. |
| `description` | One-sentence summary | Clear statement of what the plugin does. |
| `version` | `"1.1.0"` | Semantic version matching the GitHub release tag. |
| `logo` | `"assets/logo.svg"` | Relative path to a 1:1 square icon with padding. |
| `suggestedPrompts` | 3 Korean prompts | Example prompts displayed on the Marketplace detail page. |
| `author` | `{ "name": "hs1662", "url": "https://github.com/hs1662" }` | Author name and `https://` profile URL. |

Keep `homepage`, `repository`, `license`, and `keywords` in `plugin.json` aligned with the public GitHub repository URL (`https://github.com/hs1662/thinking-korean`) and `LICENSE` (`MIT`).

## Create the GitHub repository and release

1. Create the public repository `hs1662/thinking-korean` and push the default branch.

   ```sh
   gh repo create hs1662/thinking-korean --public --source=. --remote=origin --push
   ```

   If the repository already exists on GitHub, add the remote and push `main` instead.

   ```sh
   git remote add origin https://github.com/hs1662/thinking-korean.git
   git push -u origin main
   ```

2. Create an annotated tag matching `"version"` in `plugin.json` and push it.

   ```sh
   git tag -a v1.1.0 -m "Release v1.1.0"
   git push origin v1.1.0
   ```

3. Publish a GitHub Release for the tag.

   ```sh
   gh release create v1.1.0 --title "v1.1.0" --generate-notes
   ```

4. Validate the published GitHub repository directly with Antigravity CLI and verify exit code `0` with zero findings.

   ```sh
   agy plugin validate --strict https://github.com/hs1662/thinking-korean
   ```

5. Verify installation from the GitHub URL and confirm `thinking-korean` appears in the installed plugin list.

   ```sh
   agy plugin install https://github.com/hs1662/thinking-korean
   agy plugin list --json
   ```

## Submit to the Antigravity Marketplace

1. Open the [Antigravity Marketplace intake form](https://forms.gle/2EX5RFYPoJe1UgxR9).
2. Enter `https://github.com/hs1662/thinking-korean` as the plugin repository URL and match the submitted version to `"version"` in `plugin.json`.
3. Confirm that `README.md`, `README.ko.md`, `assets/logo.svg`, `hooks.json`, `rules/AGENTS.md`, `scripts/`, and `plugin.json` are committed on `main` and pass remote validation (`agy plugin validate --strict https://github.com/hs1662/thinking-korean`).
4. Re-run `node --test test/*.test.mjs` and `agy plugin validate --strict .` before pushing any follow-up commits requested during review.
