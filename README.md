# pi-codex-plugin

Use Codex from inside `pi` for review, task delegation, and follow-up analysis without leaving the workflow you already use.

This plugin is for `pi` users who want a simple way to:

- ask Codex for a second opinion on the current discussion
- hand off a focused task to Codex
- resume the latest Codex thread for the current repository
- keep the result visible inside the `pi` TUI instead of switching terminals

## What You Get

- `/codex:status`
  - Check whether local Codex is installed and authenticated
- `/codex:review`
  - Review the current situation using recent `pi` conversation context and repository files
- `/codex:diff-review`
  - Review the current Git diff only
- `/codex:task`
  - Delegate a focused task to Codex with current `pi` context
- `/codex:resume`
  - Continue the latest Codex task for the current repo

## Requirements

- `pi`
- local `codex` CLI installed
- local `codex` CLI logged in
- Node.js 20+

This plugin does not bundle Codex. It launches the local `codex` binary as a subprocess and uses the same local authentication state you would use when running Codex directly.

## Install

By default, `pi install` installs the package into your global `pi` environment, so the commands are available across repositories.

### Global install from GitHub

```bash
pi install git:github.com/johnlee6511/pi-codex-plugin
```

or

```bash
pi install https://github.com/johnlee6511/pi-codex-plugin
```

### Project-local install

If you want the plugin enabled only for the current project, use `-l`:

```bash
pi install -l https://github.com/johnlee6511/pi-codex-plugin
```

### After install

Make sure the local Codex CLI is available:

```bash
codex --version
```

If needed, sign in:

```bash
codex login
```

Then restart `pi` or run `/reload`, and verify:

```text
/codex:status
```

## Usage

Inside `pi`:

```text
/codex:status
/codex:review Analyze plan.md and tell me what is still missing
/codex:diff-review --base main Focus only on auth-related risks
/codex:task Propose the safest refactoring direction for the current structure
/codex:resume Continue the previous analysis
```

Selecting bare `/codex:review` or `/codex:task` from slash-command autocomplete does not execute immediately. The plugin primes the editor so you can type your instruction first.

## How It Feels In pi

- A preview panel appears above the editor while Codex is running
- The question and the streamed answer stay visible while the task is in progress
- The final result is rendered inside a `CODEX ANSWER` panel in chat history
- Korean instructions force Korean Codex replies; English instructions force English replies

## Typical Flows

### Ask Codex for a repo-aware review

```text
/codex:review Read plan.md and tell me what is still missing
```

### Review the current diff only

```text
/codex:diff-review --base main Focus on rollback and data-loss risk
```

### Hand off a task

```text
/codex:task Investigate the flaky test and suggest the safest fix
```

### Continue the latest Codex thread

```text
/codex:resume Continue from the previous Codex analysis
```

## How It Works

`pi-codex-plugin` does not implement its own Codex runtime. It:

1. collects the relevant `pi` conversation context
2. lets Codex inspect repository files when needed
3. launches the local `codex` CLI as a subprocess
4. streams partial Codex output back into the `pi` UI
5. stores the final answer in a `CODEX ANSWER` message

## Troubleshooting

### `/codex:status` says Codex is unavailable

Make sure:

- `codex` is installed and available on `PATH`
- `codex login` has completed successfully

`/codex:status` checks the user-level Codex CLI state. It does not read credentials from the current repo root.

### I installed the plugin but do not see the commands

Run:

```text
/reload
```

If needed, restart `pi`.

## Package Layout

```text
extensions/
  codex-bridge/
    index.ts
    bridge.ts
```

## Notes

- Streamed preview depends on `codex exec --json` events
- If Codex emits only a final message, the preview may update mostly near completion
