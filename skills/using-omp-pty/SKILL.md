---
name: using-omp-pty
description: Use when running long-lived, interactive, watch-mode, REPL, or TTY commands in Oh My Pi/OMP, especially with pty_spawn, pty_read, pty_write, pty_list, pty_kill, or when deciding between bash and persistent PTY sessions.
---

# Using OMP PTY

Use `omp-pty` when a command needs a persistent terminal session, later input, or a real TTY. Do not use it as a replacement for every shell command.

## Choose the right tool

| Need | Use | Why |
|---|---|---|
| Short non-interactive command | `bash` | Simpler; returns output and exit code immediately. |
| Long-running server, watcher, REPL, shell, TUI-like command | `pty_spawn` | Session persists across turns and accepts later input. |
| One command needing shell syntax | `bash` or explicit shell in `pty_spawn` | `pty_spawn.command` is an executable, not a shell parser. |
| Read files, search text, edit files | Dedicated tools (`read`, `search`, `edit`, etc.) | Do not use PTY or bash for tool-covered file operations. |

## Workflow

1. Start a process with `pty_spawn` and keep the returned `pty_...` ID.
2. Use `pty_read` to inspect buffered output.
3. Use `pty_write` to send input; include `\n` for shell/REPL commands.
4. Use `pty_list` to check status, exit code, timeout, and buffered line count.
5. Use `pty_kill` with `cleanup: true` when finished.

## `pty_spawn`

Important parameters:

- `command`: executable to run without an implicit shell wrapper.
- `args`: argument array; do not concatenate into one command string.
- `workdir`: working directory; defaults to current OMP cwd.
- `title`: short human-readable label.
- `description`: why this session exists.
- `notifyOnExit`: if true, OMP injects a future `<pty_exited>` message when the process exits.
- `timeoutSeconds`: optional hard stop.

Windows examples:

- Direct executable: `command: "node.exe", args: ["server.js"]`
- NPM script: `command: "npm.cmd", args: ["run", "dev"]`
- Shell features: `command: "cmd.exe", args: ["/c", "echo hi && echo done"]`
- PowerShell features: `command: "powershell.exe", args: ["-NoProfile", "-Command", "..."]`

## `notifyOnExit`

When `notifyOnExit: true`, completion is reported later as:

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

If all you need is completion, wait for `<pty_exited>` instead of polling with sleep/read loops. If exit is non-zero or timed out, call `pty_read` before cleanup.

## Windows and OMP pitfalls

- `pty_spawn` does not automatically run through a shell. Pipes, redirects, `&&`, variables, glob expansion, and built-ins require `cmd.exe` or PowerShell explicitly.
- Prefer `.cmd` wrappers for Node package CLIs on Windows (`npm.cmd`, `npx.cmd`).
- Keep `command` and `args` separate. Do not pass `"npm run dev"` as the command.
- A PTY session can keep processes alive after the current assistant turn. Always list and clean up sessions you create.

## Minimal smoke check

```text
pty_list
pty_spawn: command: cmd.exe, args: ["/c", "echo OMP_PTY_TOOL_OK"], notifyOnExit: true
pty_read: id: pty_..., offset: 0, limit: 20
pty_list
pty_kill: id: pty_..., cleanup: true
```

Expected evidence:

- `pty_list` works.
- `pty_spawn` returns `<pty_spawned>` with an ID.
- `pty_read` shows `OMP_PTY_TOOL_OK`.
- The session exits with `ExitCode: 0`.
- Cleanup removes it from the active list.
