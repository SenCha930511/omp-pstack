# Changelog

## 0.3.3 - 2026-11-27

### Poteto Mode

- One-shot `/poteto-mode <task>` uses the native `/skill:poteto-mode` path when available and falls back to the local skill prompt when it is not.
- `/poteto-mode sticky <task>` enables sticky mode and runs the task immediately.
- Foreign `skill:poteto-mode` commands with a different path no longer capture the local skill.
- Sticky state remains scoped to the session and subagents; one-shot and sticky task paths preserve attached images.

### Upstream sync

- Added `sync:ack --adapt-only` to record a partial port without advancing `lastSyncedSha`.
- The sync report omits unsafe upstream skill names from CLI suggestions, and `sync:ack` rejects names outside `[A-Za-z0-9._-]+`.
- pi-mimir range failures are reported without advancing `lastCheckedSha`; ack guidance waits for manual verification.
- The workflow runs sync scripts from the main checkout, installs the PR branch toolchain after checkout, and handles missing jq or node.
- The sync scans all non-binary text files, skips binary assets, and preserves executable bits.

### Worktree audit

- Session headers are read from title-first and legacy transcripts, with jq, Node, and awk fallbacks.
- Worktree matching is strict per repo and accepts `additionalDirectories` when a session starts outside the worktree.
- PR state is normalized without jq, so open-PR worktrees remain `hold-open-pr` when jq is unavailable.

### Tests and docs

- Added regression coverage for native skill routing, foreign skill paths, sticky tasks, image forwarding, sync ack safety, pi-mimir errors, title-first sessions, and jq-free PR state.
- Updated install and upgrade instructions for 0.3.3.

## 0.3.2 - 2026-11-27

### Setup

- `setup-pstack` now adds itself to `skills.manualSkills` after it writes the routing. The model catalog drops it from the next session, while `/skill:setup-pstack` and `skill://setup-pstack` keep working.
- The install and upgrade commands in `README.md` and `AGENT-INSTALL.md` point at 0.3.2.

### Upstream sync

- The sync computes the `pstack` range from `lastSyncedSha` with `git log <base>..<head> -- pstack` and `git diff --name-status`, instead of walking a path-filtered GitHub API list until it finds the base. A base that never touched `pstack/` no longer reports the full history.
- The upstream clone keeps full history on one branch (`--single-branch`, blobless, sparse), so any recorded base is reachable.
- The sync no longer makes one GitHub API call per commit. It runs one range script and one diff.
- `lastSyncedSha` resets to `9e278fe`, the last upstream commit under `pstack/`.
- A missing or non-ancestor base now fails the workflow with an error that names `lastSyncedSha`, instead of silently reporting the full history.
- When the range is empty, the sync closes an open `[upstream-sync]` issue with the synced SHA.

### Manual porting

- Added `npm run sync:ack -- --cursor <sha> [--pi-mimir <sha>]`. It validates the SHA, updates `lastSyncedSha` and optionally `piMimir.lastCheckedSha`, and preserves the rest of the config.
- Issue-mode reports end with `### After porting` and the exact ack command, including `--pi-mimir` when a pi-mimir commit is present.

### Docs and skills

- The README model routing examples use Claude Opus 5.5, GPT-5.4, and Claude Sonnet 5.5 instead of provider-specific model IDs.
- The `arena` skill judges model families generically and no longer names a provider.
- Added regression tests for the range script, the ack command, and the issue report instruction.

## 0.3.1 - 2026-11-26

- Switched bundled skills to hide mode: every skill is registered, all but `setup-pstack` are hidden from the model catalog, and `/skill:<name>` and `skill://<name>` both resolve them.
- Removed `SKILL-INDEX.md` and the read-as-file requirement; `poteto-mode` and `poteto-help` point at skill names again.
- The sticky payload names `/skill:<name>` and `skill://<name>` instead of package file paths.
- Rebuilds the sticky payload when its content changes, so a resumed session drops old `SKILL-INDEX` paths.
- A non-empty `skills.includeSkills` allowlist filters pstack skills out of the session; clear it or add the names.

## 0.3.0 - 2026-11-26

- Added `/poteto-mode` command: one-shot `<task>`, `sticky`, `off`, `status`.
- Sticky mode injects the full Poteto Mode skill as a hidden `custom_message`; off filters it.
- `/skill:poteto-mode` remains a native one-shot and no longer enables sticky.
- Autonomy aligned with Cursor: PR creation/updates, CI triggers, and merges no longer require prompt-level confirmation.
- `how` and `arena` use `scout`; `interrogate` uses `task`.
- `comment-sicko` remains read-only with explicit read-only tools.
- `worktree-cleanup` uses session pins and `archive.grep`; `autopilot-full` uses parent-session language and a decision log.
- `poteto-help` includes `reframe`.
- Relative skill paths and `SKILL-INDEX.md` are unchanged.

## 0.2.0 - 2026-11-26

- Ported the upstream `reframe` skill and the PR #2 sync changes.
- Replaced skill URI syntax with relative file paths across bundled docs and added local-link and URI checks.
- Aligned agent frontmatter with omp: `poteto-agent` can spawn subagents, and `comment-sicko` uses `glob` and cannot spawn.
- Moved session history lookups to the eval `archive` prelude and `history://`.
- Added fallbacks for ketchup, ketchup-video, and teach when image or visualization tools are unavailable.
- Synced Poteto Mode across session switch, branch, tree, and clear, validated entry data, and preserved systemPrompt segments.
- Added strict test typechecking plus full tarball and real omp discovery verification.

## 0.1.1 - 2026-11-26

- Fixed review findings: registered-command guidance, sticky-mode help,
  `interrogate` per-call model fallback, confirmation-guard wording, stale
  `/poteto-mode` references, and cloud-execution advice.
- Expanded skill tests to scan every markdown file under `skills/`.

## 0.1.0 - 2026-11-26

- Initial omp-only fork of `@casualjim/pi-pstack` 0.1.32.
- Skills use omp's `task` tool, `todo`, `task.agentModelOverrides`, and per-call
  `model` for panels.
- Added `skills/poteto-mode/SKILL-INDEX.md` with relative paths for every
  bundled skill.
- Removed the pi-herdr-agents role pack and the broken `/poteto-mode` extension
  command. Use `/skill:poteto-mode`.
- Reduced the extension to omp-only code paths.
- Added a GitHub Actions release workflow for npm publishing.
