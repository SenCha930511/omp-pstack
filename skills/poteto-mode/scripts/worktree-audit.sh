#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
set -u

base=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Main worktree is the first entry; collect all repo worktree roots up front for
# strict per-repo transcript filtering.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
repo_roots=()
while IFS= read -r r; do
	[ -n "$r" ] && repo_roots+=("${r%/}")
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')

if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
	done
	[ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
	echo "warn: no -b given; MERGED checks against $base" >&2
fi

# The base drives the merge check. The fetch is best-effort (stale is fine for
# a first pass) and runs before the check, since -b may name a branch not
# fetched yet. The explicit refspec creates it even in a single-branch clone.
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
	|| echo "warn: could not fetch $base; merged column may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }

# GNU coreutils (Linux, Homebrew gnubin) reads `stat -f` as file system status
# and `date -r` as a file, so pick the stat and date flags once.
if stat -c %Y / >/dev/null 2>&1; then
	stat_fmt=(-c '%Y %n'); fmt_day() { date -d "@$1" '+%Y-%m-%d'; }
else
	stat_fmt=(-f '%m %N'); fmt_day() { date -r "$1" '+%Y-%m-%d'; }
fi

# PR state by branch, fetched once as [{number, state, head}] with a lowercase
# state. Origin when its CLI can read this repo's PRs, otherwise gh. Empty when
# neither can.
prs=$(mktemp)
if command -v origin >/dev/null 2>&1 \
	&& raw=$(origin pr list --author "@me" --state all --limit 1000 \
		--json number,status,headRef 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: .status, head: .headRef}]' > "$prs" 2>/dev/null
elif raw=$(gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: (.state | ascii_downcase), head: .headRefName}]' > "$prs" 2>/dev/null
fi
[ -s "$prs" ] || echo "[]" > "$prs"

# OMP exposes PI_SESSION_FILE, whose directory may be a per-project bucket or a
# shared --session-dir. Recent OMP versions write a fixed-width session_title
# slot on line 1 followed by the session header on line 2 (older sessions have
# the session header on line 1). Scan the first lines of each candidate
# transcript for its SessionHeader and verify that cwd or additionalDirectories
# points at a repo worktree (or an ancestor workspace containing one). Foreign
# sibling projects stay excluded for privacy under shared --session-dir.
extract_session_dirs() {
	local tf="$1"
	if command -v jq >/dev/null 2>&1; then
		head -n 10 "$tf" 2>/dev/null | jq -Rnr '
			first(inputs | fromjson? | select(type == "object" and .type == "session"))
			| [(.cwd // empty), ((.additionalDirectories // [])[]?)]
			| .[]
		' 2>/dev/null
		return $?
	fi
	if command -v node >/dev/null 2>&1; then
		head -n 10 "$tf" 2>/dev/null | node -e '
			const fs = require("node:fs");
			const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
			for (const line of lines) {
				if (!line) continue;
				try {
					const obj = JSON.parse(line);
					if (obj && typeof obj === "object" && obj.type === "session") {
						if (typeof obj.cwd === "string" && obj.cwd) console.log(obj.cwd);
						if (Array.isArray(obj.additionalDirectories)) {
							for (const dir of obj.additionalDirectories) {
								if (typeof dir === "string" && dir) console.log(dir);
							}
						}
						break;
					}
				} catch {}
			}
		' 2>/dev/null
		return $?
	fi
	head -n 10 "$tf" 2>/dev/null | awk '
		function unescape_json(s,    out, i, ch, nx) {
			out = ""
			for (i = 1; i <= length(s); i++) {
				ch = substr(s, i, 1)
				if (ch == "\\" && i < length(s)) {
					nx = substr(s, i + 1, 1)
					if (nx == "\"" || nx == "\\" || nx == "/") { out = out nx; i++; continue }
					if (nx == "t") { out = out "\t"; i++; continue }
				}
				out = out ch
			}
			return out
		}
		function print_json_strings(rest,    pos, raw, i, ch, prev, endpos) {
			pos = 1
			while (match(substr(rest, pos), /"/)) {
				pos += RSTART
				raw = ""
				prev = ""
				endpos = 0
				for (i = pos; i <= length(rest); i++) {
					ch = substr(rest, i, 1)
					if (ch == "\"" && prev != "\\") {
						endpos = i
						break
					}
					raw = raw ch
					if (ch == "\\" && prev == "\\") prev = ""
					else prev = ch
				}
				if (endpos == 0) break
				if (raw != "") print unescape_json(raw)
				pos = endpos + 1
			}
		}
		/"type"[[:space:]]*:[[:space:]]*"session"/ {
			line = $0
			if (match(line, /"cwd"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
				cwd_seg = substr(line, RSTART, RLENGTH)
				sub(/^"cwd"[[:space:]]*:[[:space:]]*"/, "", cwd_seg)
				sub(/"$/, "", cwd_seg)
				if (cwd_seg != "") print unescape_json(cwd_seg)
			}
			if (match(line, /"additionalDirectories"[[:space:]]*:[[:space:]]*\[[^\]]*\]/)) {
				arr_seg = substr(line, RSTART, RLENGTH)
				sub(/^"additionalDirectories"[[:space:]]*:[[:space:]]*\[/, "", arr_seg)
				sub(/\]$/, "", arr_seg)
				print_json_strings(arr_seg)
			}
			exit
		}
	' 2>/dev/null
}

transcript_belongs_to_repo() {
	local tf="$1"
	[ "$tf" = "$session_file" ] && return 0
	local dirs d resolved r
	dirs=$(extract_session_dirs "$tf") || return 1
	[ -n "$dirs" ] || return 1
	while IFS= read -r d; do
		[ -n "$d" ] || continue
		resolved="$d"
		if [ -d "$d" ]; then
			resolved=$(cd "$d" 2>/dev/null && pwd -P) || resolved="$d"
		fi
		[ "$d" != "/" ] && d="${d%/}"
		[ "$resolved" != "/" ] && resolved="${resolved%/}"
		for r in "${repo_roots[@]}"; do
			if [ "$d" = "$r" ] || [[ "$d" == "$r/"* ]] || [ "$resolved" = "$r" ] || [[ "$resolved" == "$r/"* ]]; then
				return 0
			fi
			if { [ -n "$d" ] && [ "$d" != "/" ] && [[ "$r" == "$d/"* ]]; } \
				|| { [ -n "$resolved" ] && [ "$resolved" != "/" ] && [[ "$r" == "$resolved/"* ]]; }; then
				return 0
			fi
		done
	done <<< "$dirs"
	return 1
}

session_file="${PI_SESSION_FILE:-}"
repo_transcripts=()
if [ -n "$session_file" ] && [ -f "$session_file" ]; then
	sessions_dir=$(dirname "$session_file")
	if [ -d "$sessions_dir" ]; then
		while IFS= read -r tf; do
			[ -n "$tf" ] || continue
			if transcript_belongs_to_repo "$tf"; then
				repo_transcripts+=("$tf")
			fi
		done < <(find "$sessions_dir" -type f -name '*.jsonl' 2>/dev/null)
	else
		repo_transcripts+=("$session_file")
	fi
fi
now=$(date +%s)

find_matching_transcripts() {
	local wt="$1"
	[ "${#repo_transcripts[@]}" -gt 0 ] || return 0
	if command -v rg >/dev/null 2>&1; then
		rg -l -F -e "${wt}/" -e "${wt}\"" -- "${repo_transcripts[@]}" 2>/dev/null
	else
		grep -l -F -e "${wt}/" -e "${wt}\"" -- "${repo_transcripts[@]}" 2>/dev/null
	fi
}

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' | while IFS= read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of the base, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" "$base" 2>/dev/null && merged=YES || merged=no

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	pr=$([ -n "$branch" ] && jq -r --arg b "$branch" \
		'.[] | select(.head==$b) | "#\(.number)/\(.state)"' "$prs" 2>/dev/null | head -1)
	[ -z "$pr" ] && pr="-"

	# Most recent chat whose transcript operated in this worktree. Match path
	# followed by "/" or a quote so glint-482 does not match glint-482-r37.
	last="-"; last_ts=0
	if [ "${#repo_transcripts[@]}" -gt 0 ]; then
		while IFS= read -r tf; do
			[ -n "$tf" ] || continue
			ts=$(stat "${stat_fmt[@]}" "$tf" 2>/dev/null | awk '{print $1}')
			if [ -n "$ts" ] && [ "$ts" -gt "$last_ts" ] 2>/dev/null; then
				last_ts="$ts"
			fi
		done < <(find_matching_transcripts "$wt")
		if [ "$last_ts" -gt 0 ] 2>/dev/null; then
			last=$(fmt_day "$last_ts" 2>/dev/null)
		fi
	fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	case "$dirty" in wip:*) bucket=hold-wip ;; *)
		case "$pr" in */open|*/draft) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-chat
			elif [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

rm -f "$prs"
