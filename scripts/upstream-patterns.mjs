export const FORBIDDEN_PATTERNS = [
  { label: "~/.cursor/", regex: /~\/\.cursor\// },
  { label: "subagent_type", regex: /\bsubagent_type\b/ },
  { label: "cloud_base_branch", regex: /\bcloud_base_branch\b/ },
  { label: "pstack-models.mdc", regex: /pstack-models\.mdc/ },
  { label: 'environment: "cloud"', regex: /environment:\s*"cloud"/ },
  { label: "AskQuestion", regex: /\bAskQuestion\b/ },
  { label: "agent-transcripts/", regex: /agent-transcripts\// },
  { label: "cursor-team-kit", regex: /cursor-team-kit/ },
  { label: "generalPurpose", regex: /\bgeneralPurpose\b/ },
  { label: "/visualize", regex: /\/visualize\b/ },
  { label: "plugins/cache/", regex: /plugins\/cache\// },
];

export function findForbiddenReferences(text) {
  const matches = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.regex.test(text)) matches.push({ pattern: pattern.label });
  }
  return matches;
}
