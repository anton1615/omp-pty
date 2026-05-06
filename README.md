# omp-pty

Persistent PTY session tools for Oh My Pi / OMP coding agent sessions.

`omp-pty` is an OMP-native extension adapted from the PTY core shape of [`shekohex/opencode-pty`](https://github.com/shekohex/opencode-pty). The OMP adapter lives in `src/omp/`; the PTY manager, lifecycle, buffering, notifications, and `bun-pty` process spawning live under `src/plugin/pty/` to keep future upstream core updates easier to compare and port.

## What it adds

Tools:

- `pty_spawn` — start a persistent PTY session.
- `pty_read` — read buffered output with pagination or regex filtering.
- `pty_write` — send input to a running session.
- `pty_list` — list current OMP session PTYs by default, or all PTYs in this process with `all: true`.
- `pty_kill` — terminate a session and optionally remove its buffered output.

Commands:

- `/pty-list` — show active PTY sessions for the current OMP session.
- `/pty-kill-all` — terminate and clean up every PTY owned by the current OMP session.

Use this extension for long-running servers, watchers, REPLs, database CLIs, shells, and other commands that need a real terminal or later input. Keep using the normal `bash` tool for short one-shot commands.

PTY sessions are scoped to the current OMP conversation session by default. `pty_read`, `pty_write`, and `pty_kill` reject PTY IDs from other OMP sessions in the same process; `pty_list` shows only the current session unless `all: true` is passed. On a confirmed OMP session switch, PTYs from the previous session are cleaned up. Separate OMP windows normally run in separate OS processes and therefore have independent PTY managers.

## Install

Clone this repository directly into OMP's user extension directory. OMP discovers extension packages one level below `~/.omp/agent/extensions/`, so no `extensions:` config entry is required when the repo is in this location.

Windows PowerShell:

```powershell
git clone git@github.com:anton1615/omp-pty.git "$env:USERPROFILE\.omp\agent\extensions\omp-pty"
```

Unix-like shells:

```sh
git clone git@github.com:anton1615/omp-pty.git ~/.omp/agent/extensions/omp-pty
```

Then restart or reload OMP. OMP should discover this extension entry automatically:

```text
~/.omp/agent/extensions/omp-pty/index.ts
```

This is the supported installation path for `omp-pty`. Marketplace and npm plugin installation are not used for this extension.

If you also want agent-side usage guidance, keep or install the separate user skill at `~/.omp/agent/skills/using-omp-pty/SKILL.md`. The skill is intentionally not bundled in this repo because OMP does not load skills from native extension directories.

## Usage

Start a session:

```text
pty_spawn:
  command: cmd.exe
  args: ["/c", "echo OMP_PTY_TOOL_OK"]
  workdir: /path/to/project
  title: smoke check
  description: verify omp-pty is loaded
  notifyOnExit: true
```

Read output:

```text
pty_read:
  id: pty_...
  offset: 0
  limit: 40
```

`pty_read` defaults to 500 lines or matches when `limit` is omitted. Regex `pattern` matching is case-sensitive by default; pass `ignoreCase: true` when you want case-insensitive matching. Output lines are numbered and truncated to keep tool results bounded.
List sessions:

```text
pty_list:
  all: false
```

Use `all: true` only when you need to inspect every PTY owned by this OMP process across conversation sessions.


Send input to an interactive process:

```text
pty_write:
  id: pty_...
  data: "help\n"
```

`pty_write` parses literal escape sequences before writing: `\n`, `\r`, `\t`, `\xNN`, `\uNNNN`, and `\\`. Send `"\x03"` for Ctrl-C.

Clean up when done:

```text
pty_kill:
  id: pty_...
  cleanup: true
```

## `notifyOnExit`

When `notifyOnExit: true`, the extension injects a future message after the process exits:

```xml
<pty_exited>
ID: pty_...
Description: ...
Exit Code: 0
TimeoutSeconds: none
Timed Out: no
Output Lines: 12
Last Line: ready
</pty_exited>

Use pty_read to check the full output.
```

If all you need is completion, wait for `<pty_exited>` instead of polling output with sleep loops. If the exit is non-zero or timed out, read buffered output before cleanup.

## Windows notes

`pty_spawn` runs an executable directly; it does not implicitly use a shell. Shell syntax such as pipes, redirects, `&&`, environment expansion, and built-ins requires an explicit shell:

```text
command: cmd.exe
args: ["/c", "echo first && echo second"]
```

For Node package CLIs on Windows, prefer `.cmd` wrappers:

```text
command: npm.cmd
args: ["run", "dev"]
```

Keep the executable and arguments separate. Do not pass `"npm run dev"` as a single command string.

## Development

Install dependencies:

```sh
bun install
```

Run verification:

```sh
bun run check
```

The test suite covers:

- upstream-shaped core file layout;
- the `bun-pty` read-loop race workaround;
- ring-buffer pagination, overflow, and large-chunk performance;
- PTY manager spawn/read/write/list/kill behavior;
- `notifyOnExit` and timeout exit notifications;
- real shell PTY smoke behavior;
- OMP tool adapter registration and execution.

## Architecture

- `index.ts` exports the OMP extension factory.
- `src/omp/extension.ts` is the OMP adapter: tools, commands, lifecycle hooks, and OMP messages.
- `src/plugin/pty/` contains the portable PTY core.
- `src/pty-manager.ts` and `src/ring-buffer.ts` are compatibility re-export wrappers.

This split intentionally keeps OMP-specific code out of the PTY core so upstream changes can be manually diffed and ported with less churn.
