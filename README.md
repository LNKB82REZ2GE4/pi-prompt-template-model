<p>
  <img src="banner.png" alt="pi-prompt-template-model" width="1100">
</p>

# Prompt Template Model Extension

**Pi prompt templates on steroids.** Adds `model`, `skill`, and `thinking` frontmatter support. Create specialized agent modes that switch to the right model, set thinking level, and inject the right skill, then auto-restore when done.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  You're using Opus                                                          │
│       │                                                                     │
│       ▼                                                                     │
│  /debug-python  ──►  Extension detects model + skill                        │
│       │                                                                     │
│       ▼                                                                     │
│  Switches to Sonnet  ──►  Queues tmux skill context for next turn           │
│       │                                                                     │
│       ▼                                                                     │
│  Agent responds with Sonnet + tmux expertise                                │
│       │                                                                     │
│       ▼                                                                     │
│  agent_end fires  ──►  Restores Opus                                        │
│       │                                                                     │
│       ▼                                                                     │
│  You're back on Opus                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why?

Create switchable agent "modes" with a single slash command. Each mode bundles:

- **The right model** for the task complexity and cost tradeoff
- **The right skill** so the agent knows exactly how to approach it
- **Auto-restore** to your daily driver when done

Instead of manually switching models and hoping the agent picks up on the right skill, you define prompt templates that configure both. `/quick-debug` spins up a cheap fast agent with REPL skills. `/deep-analysis` brings in the heavy hitter with refactoring expertise. Then you're back to your normal setup.

## Installation

```bash
pi install npm:pi-prompt-template-model
```

Restart pi to load the extension.

For delegated subagent execution (`subagent` and `inheritContext` frontmatter), install [pi-subagents](https://github.com/nicobailon/pi-subagents/) separately:

```bash
pi install npm:pi-subagents
```

pi-subagents is optional — everything else works without it. If you use `subagent: true` in a prompt template without pi-subagents installed, execution fails fast with a clear error.

## Quick Start

Add `model` (or omit it to inherit the current session model) and optionally `skill` to any prompt template:

```markdown
---
description: Debug Python in tmux REPL
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL session and help me debug: $@
```

Run `/debug-python some issue` and the agent has:
- Sonnet as the active model
- Full tmux skill instructions already loaded
- Your task ready to go

## Skills as a Cheat Code

Normally, skills work like this: pi lists available skills in the system prompt, the agent sees your task, decides it needs a skill, and uses the read tool to load it. That's an extra round-trip, and the agent might not always pick the right one.

With the `skill` field, you're forcing it:

```markdown
---
description: Browser testing mode
model: claude-sonnet-4-20250514
skill: surf
---
$@
```

Here `skill: surf` loads `~/.pi/agent/skills/surf/SKILL.md` and injects its content as a context message on the next turn before the agent handles your task. No decision-making, no read tool, just immediate expertise. It's a forcing function for when you know exactly what workflow the agent needs.

## Delegated Subagent Execution

You can delegate a prompt template directly to the `subagent` extension without metaprompted tool-call instructions.

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: true
---
Review and simplify this code: $@
```

`subagent: true` uses the default `worker` agent. To target a specific agent, set a string value:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
---
Audit this diff for correctness and edge cases: $@
```

`inheritContext: true` maps to delegated `context: "fork"`. It is valid only when `subagent` is configured.

Forked subagents receive a default preamble (from the subagent extension's `DEFAULT_FORK_PREAMBLE`) that anchors them to the task and prevents them from continuing the parent conversation.

During execution, a live progress widget appears above the editor showing elapsed time, tool count, token usage, and the current/last tool — matching the native subagent tool card layout. The widget updates in real-time and clears when the run completes, replaced by a styled completion card with task preview, tool call history, output, and usage stats.

You can override delegation at runtime per invocation:

- `--subagent`
- `--subagent=<name>`
- `--subagent:<name>`

Runtime flags take precedence for that invocation only. Bare `--subagent` keeps template agent when present, otherwise defaults to `worker`.

## Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | No | `current` | Target model(s). If omitted on a non-chain template, execution inherits the current session model. Ignored when `chain` is set. |
| `chain` | Conditional | - | Chain declaration (`step -> step --loop 2`) for orchestration templates; body is ignored |
| `skill` | No | - | Skill name to inject as next-turn context message |
| `thinking` | No | - | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `subagent` | No | - | Delegate execution to subagent mode (`true` for default `worker`, or explicit agent name string) |
| `inheritContext` | No | `false` | Only with `subagent`; when `true`, delegates with subagent `context: "fork"` |

| `description` | No | - | Shown in autocomplete |
| `restore` | No | `true` | Restore previous model and thinking level after response |
| `fresh` | No | `false` | Collapse context between loop iterations (applies when looping via `--loop` or frontmatter `loop`) |
| `loop` | No | - | Default loop count for this template (`1`-`999`) |
| `converge` | No | `true` | Loop convergence behavior; set `false` to always run all iterations |

## Model Format

```yaml
model: claude-sonnet-4-20250514            # Model ID only - auto-selects provider
model: anthropic/claude-sonnet-4-20250514  # Explicit provider/model
```

When you specify just the model ID, the extension picks a provider automatically based on where you have auth configured, preferring: `anthropic` → `github-copilot` → `openrouter`.

For explicit control:

```yaml
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: github-copilot/claude-opus-4-5   # Via Copilot subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter
model: openai/gpt-5.2                   # Direct OpenAI API
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)
```

## Model Fallback

Specify multiple models as a comma-separated list. The extension tries each one in order and uses the first that resolves and has auth configured.

```yaml
model: claude-haiku-4-5, claude-sonnet-4-20250514
```

This tries Haiku first. If it can't be found or has no API key, falls back to Sonnet. Useful when you have multiple provider accounts with different availability, or want a cost-optimized primary with a guaranteed fallback.

You can mix bare model IDs and explicit provider/model specs:

```yaml
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5, claude-sonnet-4-20250514
```

Here the extension tries Haiku on Anthropic first, then Haiku on OpenRouter, then Sonnet on whatever provider has auth. If you're already on one of the listed models when the command runs, it uses that without switching.

When all candidates fail, a single error notification lists everything that was tried.

## Inline Model Conditionals

Prompt bodies can embed model-specific instructions directly in the markdown:

```markdown
---
description: Cross-model code review
model: claude-haiku-4-5, claude-sonnet-4-20250514
---
Summarize the change first.

<if-model is="claude-haiku-4-5">
Keep the answer brief and cost-conscious.
<else>
Do a deeper pass and call out subtle risks.
</if-model>
```

Conditionals are evaluated against the model that actually runs the command. For fallback prompts, that means after candidate resolution; for prompts without `model`, that means the current session model. The same template can render differently depending on which model is active.

Supported matches inside `is="..."`:

- Exact `provider/model-id`
- Exact bare `model-id`
- Provider wildcard like `anthropic/*`
- Comma-separated lists combining any of the above

Examples:

```markdown
<if-model is="anthropic/claude-sonnet-4-20250514">...</if-model>
<if-model is="claude-sonnet-4-20250514">...</if-model>
<if-model is="anthropic/*">...</if-model>
<if-model is="openai/gpt-5.2, anthropic/*">...</if-model>
```

`<else>` is the fallback branch for the current `<if-model>` block. Nested blocks are supported.

Conditionals are a raw text preprocessing step, not markdown-aware syntax. If you want to show the directive literally inside a prompt, escape it in the source text, for example with `&lt;if-model is="anthropic/*"&gt;`.

## Argument Substitution

Prompt bodies support argument placeholders that expand to command arguments:

| Placeholder | Description |
|-------------|-------------|
| `$1`, `$2`, ... | Positional argument (1-indexed) |
| `$@` | All arguments joined with spaces |
| `@$` | Alias for `$@` |
| `$ARGUMENTS` | Same as `$@` |
| `${@:N}` | All arguments from position N onward |
| `${@:N:L}` | L arguments starting from position N |

Example:

```markdown
---
model: claude-sonnet-4-20250514
---
Analyze $1 focusing on $2. Additional context: ${@:3}
```

Running `/analyze src/main.ts performance edge cases error handling` expands to:
- `$1` → `src/main.ts`
- `$2` → `performance`
- `${@:3}` → `edge cases error handling`

## Skill Resolution

The `skill` field accepts either a bare skill name or a slash-command style name:

```yaml
skill: tmux
# also valid
skill: skill:tmux
```

Resolution order:
1. Registered skill commands from `pi.getCommands()` (`source: "skill"`), matched by `skill:name` or `name`
2. `<cwd>/.pi/skills/<name>/SKILL.md` or `<cwd>/.pi/skills/<name>.md`
3. `.agents/skills` in `cwd` and ancestor directories (up to git repo root)
4. `~/.pi/agent/skills/<name>/SKILL.md` or `~/.pi/agent/skills/<name>.md`
5. `~/.agents/skills/<name>/SKILL.md` or `~/.agents/skills/<name>.md`

If the configured skill file is missing or unreadable, the command fails fast and does not send the prompt body to the model.

## Subdirectories

Organize prompts in subdirectories for namespacing:

```
~/.pi/agent/prompts/
├── quick.md                    → /quick (user)
├── debug-python.md             → /debug-python (user)
└── frontend/
    ├── component.md            → /component (user:frontend)
    └── hook.md                 → /hook (user:frontend)
```

The subdirectory shows in autocomplete as the source label. Command names are based on filename only. If duplicates exist within the same source layer, the first one found after lexical sorting wins and later duplicates are skipped with a warning. Reserved command names like `model`, `reload`, and `chain-prompts` are also skipped with a warning.

## Examples

**Cost optimization** - use Haiku for simple summarization:

```markdown
---
description: Save progress doc for handoff
model: claude-haiku-4-5
---
Create a progress document that captures everything needed for another 
engineer to continue this work. Save to ~/Documents/docs/...
```

**Skill injection** - guarantee the agent has REPL expertise:

```markdown
---
description: Python debugging session
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL and help me debug: $@
```

**Browser automation** - pair surf skill with a capable model:

```markdown
---
description: Test user flow in browser
model: claude-sonnet-4-20250514
skill: surf
---
Test this user flow: $@
```

**Deep thinking** - max thinking for complex analysis:

```markdown
---
description: Deep code analysis with extended thinking
model: claude-sonnet-4-20250514
thinking: high
---
Analyze this code thoroughly, considering edge cases and potential issues: $@
```

**Model fallback** - prefer cheap, fall back to reliable:

```markdown
---
description: Save progress doc for handoff
model: claude-haiku-4-5, claude-sonnet-4-20250514
---
Create a progress document that captures everything needed for another 
engineer to continue this work. Save to ~/Documents/docs/...
```

**Cross-provider fallback** - same model, different providers:

```markdown
---
description: Quick analysis
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5
---
$@
```

**Mode switching** - stay on the new model:

```markdown
---
description: Switch to Haiku for this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

## Chaining Templates

The `/chain-prompts` command runs multiple templates sequentially. Each step switches to its own model (or, if the step has no `model`, to the chain-start model snapshot), renders inline model conditionals against that resolved step model, injects its own skill context message, and conversation context carries forward between steps.

```
/chain-prompts analyze-code -> fix-plan -> summarize -- src/main.ts
```

This runs `analyze-code` first, then `fix-plan` (which sees the analysis in conversation context), then `summarize`. The ` -- src/main.ts` part is optional. The literal ` -- ` separator means "shared args start here": everything after it is passed to each step as `$@`, unless that step already has its own inline args.

Each step can also receive its own args, overriding the shared args for that step:

```
/chain-prompts analyze-code "look at error handling" -> fix-plan "focus on perf" -> summarize
```

Here `analyze-code` gets `$@ = "look at error handling"`, `fix-plan` gets `$@ = "focus on perf"`, and `summarize` has no per-step args so it falls back to the shared args (empty in this case, but conversation context from prior steps is usually enough).

You can mix both:

```
/chain-prompts analyze-code "error handling" -> fix-plan -> summarize -- src/main.ts
```

Step 1 uses its per-step args (`"error handling"`), steps 2 and 3 fall back to the shared args (`"src/main.ts"`).

The chain captures your current model and thinking level before starting, and restores them when the chain finishes (or if any step fails mid-chain). Individual template `restore` settings are ignored during chain execution.

### Chain Templates

For reusable pipelines, define a chain in frontmatter instead of typing `/chain-prompts` every time:

```markdown
---
description: Review then clean up
chain: double-check --loop 2 -> deslop --loop 2
---
ignored — chain templates don't use the body
```

This registers `/review-then-clean` as a command that runs `double-check` twice, then `deslop` twice. Each step references a separate prompt template. Steps with `model` use their configured model; steps without `model` inherit the chain-start model snapshot (the model active when the chain command began), so behavior stays deterministic even if earlier steps switch models.

Per-step `--loop N` repeats that step N times before moving to the next. Per-step convergence applies: if a step makes no file changes on an iteration, its inner loop stops early (unless the step's template has `converge: false`).

Chain templates support `loop`, `fresh`, `converge`, and `restore` in their frontmatter for overall execution control:

```markdown
---
chain: analyze -> fix
loop: 3
fresh: true
converge: false
---
```

This runs the full analyze → fix chain 3 times, with fresh context between iterations and no early stopping. CLI `--loop` overrides frontmatter `loop` when invoking the command.

Chain nesting is not supported — a chain template's steps cannot reference other chain templates.

## Loop Execution

Looping uses the `--loop` flag:

```
/deslop --loop 5
/deslop --loop=5
/deslop "focus on performance" --loop 3
/deslop --loop
```

`--loop` without a number means unlimited looping until convergence, with a built-in safety cap of 50 iterations.

You can also set a default loop count in frontmatter:

```markdown
---
model: claude-sonnet-4-20250514
loop: 5
---
...
```

With that template, `/deslop` runs 5 iterations by default. CLI `--loop` overrides frontmatter (`/deslop --loop 3` runs 3 iterations).

The agent runs the same prompt N times. Context accumulates across iterations — by iteration 3, the agent sees the full conversation from iterations 1 and 2 and builds on that work. Use `--fresh` to collapse context between iterations instead (see below).

By default, the loop stops early if an iteration makes no file changes (no `write` or `edit` tool calls), since there's nothing left to improve. Add `--no-converge` to always run all iterations for bounded loops, or set `converge: false` in frontmatter:

```
/deslop --loop 5 --no-converge
```

```markdown
---
model: claude-sonnet-4-20250514
loop: 5
converge: false
---
...
```

Bare `--loop` always forces convergence on (even with `--no-converge` or `converge: false`) because its intent is "run until no changes." `--loop N` and `--loop=N` support range 1-999. Quoted `"--loop"` is treated as a regular argument.

Model, thinking level, and skill are maintained throughout the loop. If the template has `restore: true` (the default), the original model and thinking level are restored after the final iteration (or if any iteration fails). If `restore: false`, the switched model persists after the loop ends.

### Fresh Context

Add `--fresh` to collapse context between iterations:

```
/deslop --loop 5 --fresh
/deslop --fresh      # when frontmatter sets loop: N
```

Each iteration's conversation is collapsed to a brief summary (files read, files modified, outcome) before the next iteration starts. The agent sees accumulated summaries from all previous iterations but not the full conversation. This saves tokens on long loops and gives each iteration a clean slate for reasoning.

You can also set `fresh: true` in the template frontmatter to make it the default when looped:

```markdown
---
description: Remove AI slop from code
model: claude-sonnet-4-20250514
fresh: true
---
Review the codebase and improve code quality. $@
```

### Loop with Chains

Chains support the same looping forms:

```
/chain-prompts analyze -> fix --loop 3
/chain-prompts analyze -> fix --loop=3
/chain-prompts analyze -> fix --loop
/chain-prompts analyze -> fix --loop 3 --fresh
/chain-prompts analyze -> fix --loop 3 --no-converge
/chain-prompts analyze -> fix --loop 3 -- src/main.ts
```

This runs the full chain (analyze → fix) three times. The final example adds optional shared args: ` -- src/main.ts` means "pass `src/main.ts` to any step that doesn't already have its own args." If you don't need shared args, leave that part out entirely. Convergence detection applies across all steps in each iteration — if no step made file changes, the loop stops. Each iteration re-reads prompts from disk, so template edits take effect between iterations. The status bar shows `loop 2/3` during execution. Chain frontmatter declarations also support per-step `--loop N` inside the `chain:` value (for example `chain: double-check --loop 3 -> simplify -> deslop`).

## Agent Tool

The agent can run prompt templates on its own via the `run-prompt` tool. Disabled by default — enable it with:

```
/prompt-tool on
```

Once enabled, the agent sees `run-prompt` in its tool list and can call it with any template command:

```
run-prompt({ command: "deslop --loop 5 --fresh" })
run-prompt({ command: "deslop --loop" })
run-prompt({ command: "deslop --subagent" })
run-prompt({ command: "deslop --subagent:reviewer" })
run-prompt({ command: "chain-prompts analyze -> fix --loop 3" })
```

The tool queues the command for execution when the agent's current turn ends. All loop, fresh context, and convergence features work the same as when invoked via slash commands.

Add guidance to steer when the agent uses it:

```
/prompt-tool on Use run-prompt for iterative code improvement tasks
/prompt-tool guidance Use sparingly, only for multi-pass refinement
/prompt-tool guidance clear
/prompt-tool off
/prompt-tool
```

Config persists across sessions in `~/.pi/agent/prompt-template-model.json`.

## Autocomplete Display

Commands show model, thinking level, and skill in the description:

```
/debug-python    Debug Python session [sonnet +tmux] (user)
/deep-analysis   Deep code analysis [sonnet high] (user)
/save-progress   Save progress doc [haiku|sonnet] (user)
/component       Create React component [sonnet] (user:frontend)
/quick           Quick answer [haiku] (user)
```

## Print Mode (`pi -p`)

These commands work in print mode too:

```bash
pi -p "/debug-python my code crashes on line 42"
```

The model switches, a skill context message is injected, the agent responds, and output prints to stdout. Useful for scripting or piping to other tools.

## Limitations

- Prompt files are reloaded on session start and whenever an extension-owned prompt command runs. If you add a brand-new prompt file while already inside a session, run another extension-owned command such as `/chain-prompts`, start a new session, or reload pi so the new slash command is registered.
- Model restore state is in-memory. Closing pi mid-response loses restore state.
- Model-less templates are only managed by this extension when they use extension features (for example `skill`, `thinking`, loop flags, or inline `<if-model ...>`). Plain prompt templates without extension features stay with pi's default prompt loader to avoid command conflicts.
- In chains, model-less steps inherit the chain-start model snapshot, not the immediately previous step model. This is intentional for deterministic behavior.
- Delegated `subagent` prompts require [pi-subagents](https://github.com/nicobailon/pi-subagents/) (`pi install npm:pi-subagents`).
- The `run-prompt` tool must be explicitly enabled with `/prompt-tool on` before the agent can use it.
