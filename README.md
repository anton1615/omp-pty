# omp-pty

Persistent PTY session tools for Oh My Pi / OMP coding agent sessions.

`omp-pty` is an OMP-native extension adapted from the PTY core shape of [`shekohex/opencode-pty`](https://github.com/shekohex/opencode-pty). The OMP adapter lives in `src/omp/`; the PTY manager, lifecycle, buffering, notifications, and `bun-pty` process spawning live under `src/plugin/pty/` to keep future upstream core updates easier to compare and port.

## What it adds

Tools:

- `pty_spawn` — start a persistent PTY session.
- `pty_read` — read buffered output with pagination or regex filtering.
- `pty_write` — send input to a running session.
- `pty_list` — list sessions, status, PIDs, line counts, exits, and timeouts.
- `pty_kill` — terminate a session and optionally remove its buffered output.

Commands:

- `/pty-list` — show active PTY sessions.
- `/pty-kill-all` — terminate and clean up every session owned by the extension.

Use this extension for long-running servers, watchers, REPLs, database CLIs, shells, and other commands that need a real terminal or later input. Keep using the normal `bash` tool for short one-shot commands.

## Install

### Marketplace install

```sh
omp plugin marketplace add anton1615/omp-pty
omp plugin install omp-pty@omp-pty
```

Marketplace installation makes the plugin root discoverable to OMP and loads bundled skills from `skills/*/SKILL.md` on the next session/reload. The bundled PTY skill is exposed as `omp-pty:using-omp-pty`.

Current OMP marketplace loading does not activate extension modules from marketplace-installed roots yet, so the `pty_*` tools still need the extension entry loaded explicitly.

### Enable the extension tools

Load the extension entry from your cloned or installed plugin root:

```sh
omp --extension /path/to/omp-pty/index.ts
```

Or configure OMP to load the extension entry:

```yaml
extensions:
  - /path/to/omp-pty/index.ts
```

## Usage

Start a session:

```text
pty_spawn:
  command: cmd.exe
  args: ["/c", "echo OMP_PTY_TOOL_OK"]
  workdir: C:/Users/Anton/.omp
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

Send input to an interactive process:

```text
pty_write:
  id: pty_...
  data: "help\n"
```

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
Title: ...
Command: ...
Workdir: ...
ExitCode: 0
Signal: none
TimedOut: false
</pty_exited>
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
