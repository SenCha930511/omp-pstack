---
name: setup-pstack
description: Configure which models pstack uses per agent on omp and offer to generate a project verification skill. Detects your available models and writes omp's task model routing. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or first-run pstack setup.
---

# Setup pstack

Configure omp's per-agent task routing, then offer the verification skills.

## Steps

### 1. Detect available models

Enumerate the models omp exposes this session (`/models`, or the model registry's available models). If you cannot detect any, ask the user which models they have. Never write a model you have not confirmed is available.

### 2. Load current state

Read `task.agentModelOverrides` from `~/.omp/agent/config.yml` (and the project `.omp/config.yml` if present). If `pi-model-sync` is installed, also read `~/.omp/agent/pi-model-sync.json`. Unconfigured agents inherit the parent model.

### 3. Budget, map, and confirm

Ask for a budget: `large` (highest thinking level the model supports), `medium` (one step lower), `small` (two steps lower). Show every pstack agent with its model and thinking level:

- `poteto-agent` (implementation delegate)
- `comment-sicko` (read-only comment reviewer)
- `task` (generic worker)
- `explore` (read-only investigator)
- `reviewer` (review specialist)

To inherit the parent model, leave the agent out of the mapping; omp has no `inherit-parent` value. For panel skills (`arena`, `swarm`, `interrogate`), ask whether to enable per-call model selection: `task.perCallModel: "on"` plus the chosen models in `task.perCallModelAllow`. Without it, every seat uses the agent's configured model.

### 4. Validate

Every model written must be in the detected set. If a chosen model is not available, stop and ask again.

### 5. Write the routing

Write the agreed agent-to-model mapping with `task.agentModelOverrides` in `~/.omp/agent/config.yml`. If `pi-model-sync` is installed and the user wants routing that follows the main model, write the same mapping into `~/.omp/agent/pi-model-sync.json` instead. Do not set both for the same agent: model-sync treats an override as an explicit per-call model and skips it. Do not put an agent used by a panel in `task.agentModelOverrides`; a per-call `model` and an override conflict.

### 6. Confirm

Tell the user the routing applies to new subagent spawns and that re-running this skill updates it in place.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one by following `../create-verification-skill/SKILL.md`." On yes, read and follow that file (invoke `/skill:create-verification-skill` only if it is registered). On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one by following `../create-formal-verification-skill/SKILL.md`." On yes, read and follow that file (invoke `/skill:create-formal-verification-skill` only if it is registered). On no, move on without pushing.
