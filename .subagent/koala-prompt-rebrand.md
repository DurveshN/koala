# Koala prompt rebrand

## Task objective

Remove all upstream OpenCode, GitHub, and public-cloud references from the
shipped system, tool, command-template, and agent prompts while preserving their
behavioral meaning for a local-only Koala workbench.

## Agent type

Two `explore` research subagents running in parallel:

- `ses_f30f08c31ffe8Qx1vygeJT8JPX` — prompt audit
- `ses_f30f07a45ffe6R8VguOLkT6kK2` — tool registry visibility audit

Direct implementation by the orchestrating agent.

## Files inspected

All `.txt` files under:

- `packages/opencode/src/session/prompt/`
- `packages/opencode/src/tool/`
- `packages/opencode/src/command/template/`
- `packages/opencode/src/agent/prompt/`

## Verified findings

### Prompt references

Multiple shipped prompts still identified the assistant as "OpenCode" or
"opencode", pointed users to upstream GitHub issues, instructed the model to use
`WebFetch` against `opencode.ai/docs`, or told the model to do Internet/Google
research. Examples:

- `packages/opencode/src/session/prompt/default.txt` pointed feedback to
  `https://github.com/anomalyco/opencode/issues`.
- `packages/opencode/src/session/prompt/meta.txt` referenced
  `https://opencode.ai/docs` and GitHub feedback.
- `packages/opencode/src/tool/shell/shell.txt` instructed use of `gh` for GitHub
  PRs/issues/releases.
- `packages/opencode/src/session/prompt/beast.txt` instructed use of `webfetch`
  and Google search.
- `packages/opencode/src/command/template/review.txt` included a `gh pr`
  review path.

### Tool registry visibility

The tool registry itself registers the full OpenCode tool set (read, write,
edit, glob, grep, task, skill, calculate, sandbox_execute, sandbox_test,
knowledge tools, document tools, apply_patch, etc.) but several explicit filters
hide subsets from the model:

- `bash` is hidden when `agentExecution` is `sandbox` (Koala Desktop default).
- `sandbox_execute`/`sandbox_test` are hidden unless execution mode is `sandbox`
  or `both`.
- Document tools are hidden unless `DocumentRuntime` reports available or
  `KOALA_ENABLE_DOCUMENT_TOOLS=1`.
- `websearch` is hidden for non-OpenCode/non-Exa providers.
- `apply_patch` is hidden for non-GPT local models; `edit`/`write` are shown.
- `lsp`, `execute` (code-mode), and `plan_exit` are hidden behind experimental
  flags.
- `session/llm/request.ts` further filters by agent/session permissions and user
  tool toggles.

Therefore the truncated "Available tools" error message in the UI is
presentation-level truncation of an otherwise correctly filtered list, not a
registration bug. The full local tool set is present subject to the filters
above.

## Changes made

Replaced OpenCode/GitHub/cloud language in:

- `packages/opencode/src/command/template/initialize.txt`
- `packages/opencode/src/command/template/review.txt`
- `packages/opencode/src/tool/lsp.txt`
- `packages/opencode/src/tool/shell/shell.txt`
- `packages/opencode/src/tool/webfetch.txt`
- `packages/opencode/src/tool/websearch.txt`
- `packages/opencode/src/session/prompt/anthropic.txt`
- `packages/opencode/src/session/prompt/beast.txt`
- `packages/opencode/src/session/prompt/codex.txt`
- `packages/opencode/src/session/prompt/copilot-gpt-5.txt`
- `packages/opencode/src/session/prompt/default.txt`
- `packages/opencode/src/session/prompt/gemini.txt`
- `packages/opencode/src/session/prompt/gpt-astra.txt`
- `packages/opencode/src/session/prompt/gpt.txt`
- `packages/opencode/src/session/prompt/kimi.txt`
- `packages/opencode/src/session/prompt/meta.txt`
- `packages/opencode/src/session/prompt/trinity.txt`

Also updated `packages/opencode/test/session/system.test.ts` to reflect the new
Koala wording and the removed GitHub feedback line for Meta prompts.

The workspace compatibility filenames `opencode.json` / `opencode.jsonc` were
kept as config references because the project-level contract still uses those
names; only the surrounding "OpenCode config" wording was changed to "project
config".

## Tests or commands run

- `bun typecheck` from `packages/opencode`: passed.
- `bun test test/session/system.test.ts test/tool/task.test.ts test/tool/registry.test.ts`:
  48 passed, 0 failed.

## Commit

`refactor(opencode/prompts): rebrand shipped prompts for Koala and tighten local-model tool calls`

## Integration recommendation

Re-test the Gemma/local-model chat flow. If the model still appears to see only a
few tools, verify the runtime flags (`KOALA_AGENT_EXECUTION`,
`KOALA_ENABLE_DOCUMENT_TOOLS`, etc.) and agent permission rules rather than the
registry, because the tools are registered and the filters are deliberate.
