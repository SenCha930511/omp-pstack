# Changelog

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
