---
name: pty-bridge
description: Run and drive persistent interactive terminal (PTY) sessions through a local CLI. Use when work needs a terminal that outlives a single tool call — the program requires a real TTY, must receive input while it runs, keeps state that later steps depend on, or has to be read as a rendered screen. Skip it when the regular shell tool can run the command to completion on its own.
metadata:
  version: "1.7.0"
---

# pty-bridge

A local daemon keeps PTY sessions alive between tool calls; the `pty-bridge` CLI drives them.
Needs CLI 1.7.0+ (`pty-bridge --version`). Install or upgrade: `npm i -g github:briqt/pty-bridge --install-links` (Node.js 18+).
Versions, update notices and upgrades: [references/updates.md](references/updates.md).

## Core loop

```bash
pty-bridge start bash --name build                 # → Session: <id> name=build
pty-bridge exec build "make test" --wait-exit --wait 120000
pty-bridge kill build
```

- `<session>` is the id or the `--name` given at start. Pick a descriptive, unique name: it is easier to keep across long tasks than an id.
- **Shell sessions:** use `exec --wait-exit`. It returns only the command's output, then `[status=done|failed exitCode=N]`. It appends `; echo <sentinel>` to the command, so use it only in POSIX-style shells.
- **Other programs** (REPLs, clients, editors): `exec` without `--wait-exit` returns the output so far, ending with the program's prompt; or use `write` + `sendkey enter`.
- **Prompts that need answers:** check them with `read` / `snapshot`, then `write` the answer and `sendkey enter`. Pipe secrets in with `write <session> --stdin` from a credential source. Never put them in arguments.
- **Full-screen programs:** `snapshot` shows the visible screen; `sendkey` sends keys (`enter tab escape up down left right pageup pagedown ctrl-a…ctrl-z`).
- **Waiting on output:** `wait-for <session> <pattern> --from-now --timeout <seconds>`.
- **Idle remote connections:** add `--keepalive <seconds>` at start.
- If something looks stuck, inspect it (`read`, `snapshot`) before acting; `sendkey <session> ctrl-c` interrupts.

## Reading results

stdout is terminal content. stderr ends with one `[key=value …]` line that lists only the fields that matter:

- `status=still_running` is **not** a failure: the input was already sent. **Never resend it.** Continue with `read <session> --from-exec`, `read`, or `wait-for`. RPC timeouts work the same way.
- `truncated=true … cursor=C` means more output exists: `read <session> --from C`.
- `alive=false` means the process exited (see `exitCode`).
- `lostBytes=N` (raw reads) means old output was evicted. Report the gap; don't treat the output as complete.
- `read` is incremental by default. `--last N`, `--full` and `--from C` do not move its cursor; `--raw` returns unwrapped bytes.

## Sessions and isolation

Every agent running as the same OS user shares one daemon, so `list` also shows sessions you did not start.

- Operate only on sessions you started, unless the user asks you to take one over.
- If interference from other agents would be costly, lock the session when you start it: `--owner <unique-name>` (or set `PTY_BRIDGE_OWNER`). Every mutating call must then repeat that owner, and anyone else needs `--force`. Sessions are unlocked by default.
- Kill your sessions when you are done. The daemon exits 5 minutes after its last session.

## More

- All options: `pty-bridge <command> --help`.
- Errors, daemon restarts and lost sessions: [references/troubleshooting.md](references/troubleshooting.md).
- Over SSH, move scripts and large files through a file channel (scp/sftp), not by pasting them into the PTY.
