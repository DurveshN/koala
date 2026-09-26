# Koala local-model tool hallucination fix

## Task objective

Investigate and correct wrong tool calling observed when chatting with a local
Gemma 4 E2B IT QAT model in Koala Desktop: the model emitted tool calls for
`general` and `explore` instead of using the real `task`, `glob`, `grep`, or `write`
tools.

## Agent type

`explore` research subagent (`ses_f310172e5ffewaMiX62xpoI5sK`) plus direct
implementation by the orchestrating agent.

## Files inspected

- `.subagent/koala-state-rebrand.md`
- `.subagent/model-profile-runtime-integration.md`
- `.subagent/model-routing-core-implementation.md`
- `.subagent/industrial-tools-9a-implementation.md`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/task.ts` and `task.txt`
- `packages/opencode/src/tool/skill.ts` and `skill.txt`
- `packages/opencode/src/tool/invalid.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/prompt/default.txt`
- `packages/llm/src/protocols/openai-chat.ts`
- `packages/core/src/tool/registry.ts`
- `packages/opencode/test/session/system.test.ts`
- `packages/opencode/test/tool/task.test.ts`
- `packages/opencode/test/tool/registry.test.ts`

## Verified findings

### Root cause

1. **Unknown OpenAI-compatible models fall back to the default prompt.**
   `packages/opencode/src/session/system.ts` does not recognize `gemma` model
   IDs, so Gemma receives `PROMPT_DEFAULT`.

2. **The default prompt pushes the model toward `task`.**
   `packages/opencode/src/session/prompt/default.txt` previously contained:
   `When doing file search, prefer to use the Task tool in order to reduce context usage.`
   That steers weak models to the `task` tool.

3. **The `task` tool exposes agent names as prose, not as a closed schema.**
   `packages/opencode/src/tool/registry.ts:361-374` appends a list like:

   ```text
   Available agent types and the tools they have access to:
   - general: ...
   - explore: ...
   ```

   But `packages/opencode/src/tool/task.ts:46` declares `subagent_type` as an
   unbounded `Schema.String`. The model has no JSON-schema hint that those names
   are values for one parameter of one tool.

4. **Local quantized models therefore hallucinate.** Gemma saw the agent names in
   the task description and emitted them as standalone tool names.

### What earlier subagents left unresolved

- `model-profile-runtime-integration.md` and `model-routing-core-implementation.md`
  wired local profiles/routing but added no prompt or tool-schema adaptation for
  local/quantized models.
- `koala-state-rebrand.md` only renamed persisted state paths, not system prompts.

## Assumptions and risks

- [Inference] Gemma-family local/quantized models benefit from a shorter, more
  explicit prompt than the default cloud-oriented one.
- [Inference] Closing `subagent_type` to an enum reduces free-form hallucinations
  without breaking runtime behavior, because the execution schema remains a
  string.
- [Inference] The `gemma` substring match is safe because Koala currently has
  no cloud-hosted Gemma provider; if one is added later the check should be
  narrowed to local/OpenAI-compatible provider families.

## Changes made

1. Added `packages/opencode/src/session/prompt/gemma.txt` — terse local-model
   system prompt that states agent names are not tools and direct tools should be
   used for simple file work.
2. Updated `packages/opencode/src/session/system.ts` to route model IDs
   containing `gemma` to the new prompt.
3. Updated `packages/opencode/src/session/prompt/default.txt` to prefer direct
   tools for simple file searches.
4. Updated `packages/opencode/src/tool/task.txt` to clarify agent names are
   `subagent_type` values, not tool names.
5. Updated `packages/opencode/src/tool/registry.ts` to inject an `enum` of allowed
   subagent names into the `task` tool's JSON schema.
6. Added `packages/opencode/test/session/system.test.ts` coverage for Gemma
   prompt selection.

## Tests or commands run

- `bun typecheck` from `packages/opencode`: passed.
- `bun typecheck` from `packages/core`: passed.
- `bun typecheck` from `packages/app`: passed.
- `bun test test/session/system.test.ts` from `packages/opencode`: 7 passed.
- `bun test test/tool/task.test.ts test/tool/registry.test.ts` from
  `packages/opencode`: 41 passed.

## Follow-up: Gemma "Please provide a task" loop

After the hallucination fix, a second symptom appeared: Gemma would read
`index.html` and then reply "Please provide the task you would like me to help
you with", then on the next turn emit an unrelated `task` subagent call such as
"Create a fully functional US E-commerce application...". Two rounds of
subagents reviewed whether tool results were being persisted/fed back correctly.

### Findings from review round 1

- `explore` subagent `ses_f30ba43feffeDa1XLFTZv9T91l` traced the tool-result
  pipeline and identified orphan-result, async durable-write, empty `toolCallId`,
  JSON-typed string outputs, media extraction, and lack of ID sanitization for
  local endpoints as risk points.
- `explore` subagent `ses_f30ba36e5ffeZWLfb09BlBaWQw` confirmed that the echoed
  phrases are not hard-coded in the repo and pointed to:
  - `PROMPT_DEFAULT` / `PROMPT_TRINITY` containing concrete `<example>` blocks
    that weak local models can echo as templates.
  - `task.txt` asking for a "highly detailed task description".
  - Subagent descriptions appended to the `task` tool schema.

### Findings from review round 2

- `general` subagent `ses_f30b4758bffeXO5gL09bcr6mfq` verified empirically that
  the second-turn HTTP request to an `@ai-sdk/openai-compatible` endpoint
  includes `system → user → assistant tool_call → tool result`, so tool results
  are not dropped in the normal path.
- `general` subagent `ses_f30b46d4affezZTySdpidPPMcQ` recommended:
  - Anchor `gemma.txt` with explicit instructions to honor the current request
    and reply after tool results.
  - Remove the `<example>` blocks from `default.txt` and `trinity.txt`.
  - Replace "highly detailed task description" with "clear, specific task
    description" in `task.txt`.

### Changes made for the loop

1. `packages/opencode/src/session/prompt/gemma.txt`: added anchors telling the
   model to respond to the current request directly and to continue after tool
   results.
2. `packages/opencode/src/session/prompt/default.txt`: removed the entire
   `<example>` block.
3. `packages/opencode/src/session/prompt/trinity.txt`: removed the entire
   `<example>` block.
4. `packages/opencode/src/tool/task.txt`: softened "highly detailed" to "clear,
   specific".

### Verification

- `bun typecheck` from `packages/opencode`: passed.
- `bun test test/session/system.test.ts test/tool/task.test.ts test/tool/registry.test.ts`
  from `packages/opencode`: 48 passed, 0 failed.

### Commit

`fix(opencode/prompts): anchor Gemma prompt and remove example templates that local models echo`

## Integration recommendation

Re-test the Gemma chat flow end to end. If hallucination persists, consider
narrowing `task`/`skill` exposure for identified local models or adding a small
model-format adapter (e.g., simpler tool descriptions). The current fix preserves
all existing functionality while giving local models clearer constraints and a
dedicated prompt.
