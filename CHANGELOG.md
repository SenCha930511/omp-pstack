# Changelog

## 0.3.1 - 2026-11-26

- Switched bundled skills to hide mode: every skill is registered, all but `setup-pstack` are hidden from the model catalog, and `/skill:<name>` and `skill://<name>` both resolve them.
- Removed `SKILL-INDEX.md` and the read-as-file requirement; `poteto-mode` and `poteto-help` point at skill names again.
- The sticky payload names `/skill:<name>` and `skill://<name>` instead of package file paths.
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
