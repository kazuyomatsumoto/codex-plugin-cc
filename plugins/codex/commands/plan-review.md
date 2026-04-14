---
description: Run a Codex cross-provider plan review for optimism bias and feasibility gaps
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--plan <path>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex plan review through the shared plugin runtime.
Position it as a cross-provider check for optimism bias, feasibility gaps,
and failure scenarios that the author's model missed.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing focused on whether the plan is feasible, complete, and free of optimism bias.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, recommend background for most plan reviews (plans tend to be large documents).
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:plan-review` uses the same review target selection as `/codex:adversarial-review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- Use `--plan <path>` to select a specific plan file (absolute or relative, must live under `.claude/plans/`). Omit to auto-select the newest plan in the project's `.claude/plans/` directory (or `~/.claude/plans/` when in conductor mode).
- Any positional text after the flags is passed to Codex as review focus text — it is NOT interpreted as a plan file path.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" plan-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" plan-review "$ARGUMENTS"`,
  description: "Codex plan review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex plan review started in the background. Check `/codex:status` for progress."
