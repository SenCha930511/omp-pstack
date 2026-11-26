# Agent install guide

Instructions for an AI agent helping a human install omp-pstack. Read this file
in full before running commands.

## Contract

- Ask before editing `~/.omp/agent/config.yml`. It is global and persistent.
- Never restart or kill the user's session. Tell them to start a new one.
- Run one command at a time and report its output.
- If a step fails, stop and report the failing command and its output. Do not
  guess a workaround.

## 1. Check the host

```sh
omp --version
```

omp 19.2 or newer. Node 22 or newer for npm installs.

## 2. Install

Marketplace:

```sh
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install omp-pstack@sencha930511
```

npm:

```sh
omp plugin install npm:omp-pstack@0.3.1
```

Local checkout:

```sh
omp plugin link /path/to/omp-pstack
```

Verify:

```sh
omp plugin list
```

`omp-pstack` must be listed at 0.3.1 or newer.

## 3. Upgrade an existing install

A 0.2.0 entry is the old file-path build. Adding an existing marketplace, or
installing an already-installed plugin without force, fails, so use the upgrade
path.

Marketplace:

```sh
omp plugin marketplace update sencha930511
omp plugin upgrade omp-pstack@sencha930511
```

npm:

```sh
omp plugin install npm:omp-pstack@0.3.1 --force
```

Start a new session after upgrading. A resumed session keeps its stored sticky
payload for one turn; the extension replaces it on the next turn.

## 4. Check the skill configuration

Read the user's config:

```sh
rg -n -A40 '^skills:' ~/.omp/agent/config.yml
```

Four keys can keep a skill out of the session. Check all of them:

| Key | Effect | Fix |
|---|---|---|
| `includeSkills` | non-empty allowlist; everything not listed is removed | clear it, or add the pstack names |
| `ignoredSkills` | removes matching names | delete the pstack patterns |
| `disabledExtensions: ["skill:<name>"]` | disables one skill | remove the pstack entry |
| `manualSkills` | hides matching skills from the model catalog only; `/skill:` and `skill://` still work | no action needed |

If `includeSkills` is non-empty, ask the user which they want:

- Clear the allowlist: delete the `includeSkills` block, or set it to `[]`.
- Keep it and add all 58 pstack names. Not recommended: every upstream skill
  addition needs another edit.

Explain the cost before editing. Clearing the allowlist also admits the user's
other installed skills. By default `setup-pstack` is the only pstack skill in the
model catalog; the other 57 stay hidden, so the prompt does not grow by 57
entries. `manualSkills` can hide `setup-pstack` too.

Do not edit the file without explicit approval. Back it up first:

```sh
cp ~/.omp/agent/config.yml ~/.omp/agent/config.yml.bak
```

## 5. Verify hide mode

Start a new session first. Skill discovery runs at session start.

```sh
omp skill list --json | jq -r '.skills[] | select(.name == "architect") | "\(.name) hide=\(.hide)"'
```

Expected: `architect hide=true`.

In the new session, read a skill directly:

```text
read skill://architect
```

Expected: the SKILL.md body. `Unknown skill: architect` means the skill is not
loaded; check the four keys in step 4.

`/skill:architect` must appear in the slash menu. If it does not, check that
`skills.enableSkillCommands` is `true`.

## 6. First run

```text
/poteto-mode <task>
```

One-shot. `/poteto-mode sticky` keeps it on across turns. `/poteto-mode off`
stops it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown skill: architect` | `includeSkills`, `ignoredSkills`, or `disabledExtensions` | check all four keys in step 4 |
| `/skill:architect` missing | skill not loaded, or commands disabled | check step 4 and `enableSkillCommands` |
| `omp plugin list` shows 0.2.0 | stale install | use step 3 |
| A resumed session's reply mentions `SKILL-INDEX.md` | sticky payload stored by an older build | the next turn replaces it; start a new session to apply it immediately |
| `architect` appears in the model's skill catalog | missing `disable-model-invocation` | report a bug; do not edit the skill |

## Rollback

```sh
omp plugin install npm:omp-pstack@0.3.0 --force
```

Restore the config backup if you changed it.
