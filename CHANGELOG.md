# Changelog

## v1.7.1

- `exec --wait-exit` now gets exact output boundaries from the shell instead of inferring them from the rendered echo. The shell prints a begin marker, built at run time so the echo never contains it, right before the command and the exit sentinel right after it. Output no longer depends on prompt width, line-editor redraws or wrapping. This fixes a blank first line whenever the echo exactly filled its row in zsh.
- Fix: the command now runs inside `{ …\n}`, so a trailing comment no longer swallows the sentinel (which used to wait until the timeout), a trailing `;` or `&` is no longer a syntax error, and a here-document no longer leaves the shell stuck at a continuation prompt for every later command.
- Plain `exec` (no sentinel, e.g. in a REPL) still strips the echo on a best-effort basis; it now also drops the empty row that an exactly filled echo row can leave.

## v1.7.0

- `exec --wait-exit` returns only the command's own output. The echoed input is located even when it wraps over several rows, and it is removed together with the sentinel and the redrawn prompt.
- Fix: output without a trailing newline (for example `printf abc`) was dropped together with the sentinel line.
- Fix: a sentinel wrapped by a narrow terminal, or by a long last output line, was not recognised, so `--wait-exit` waited until its timeout and reported `still_running`.
- Plain `exec` and post-timeout peeks also strip a wrapped echo of the submitted line. They keep the program's prompt.
- Metadata lines carry only actionable fields: a cursor when there is more to read, byte totals when truncated, `alive=false` when the process exited, `lostBytes` when output was evicted. The duplicate `[Process exited …]` stdout line is gone.
- Add `start --name`: stable session handles usable wherever an id is. Names are unique among live sessions and cannot look like ids; `list` and lost-session tombstones show them.
- Owner locks are opt-in. Sessions are unlocked unless started with `--owner` or `PTY_BRIDGE_OWNER`. Locked sessions keep the same guard, and sessions that older CLIs locked to the OS user stay usable without flags.
- Rewrite the skill around principles. The main file is about a quarter of its former size; troubleshooting and update details move to `skill/references/`.
- Dependencies: `@lydell/node-pty` 1.2.0-beta.18 (npm latest, all six prebuilt platforms), `@types/node` 26.6.6.

## v1.6.0

- Add `check-update [--json]` using published stable releases and semantic version ordering.
- Add bounded, cached release checks after successful start/list/status commands; reminders use stderr, with independent check/retry/cooldown intervals and concurrent cache protection.
- Add configuration, environment and command-line opt-outs; keep high-frequency PTY operations and offline diagnostics free of automatic network checks.
- Refine skill routing around terminal capabilities, document CLI/skill/daemon version separation, and fix ownership examples and secret-input guidance.
- Add update-check regressions covering version ordering, failures, caching, concurrency, disabling, HTTP bounds and CLI output.

## v1.5.1

- Put Windows daemon startup locks beside the state file rather than under the named-pipe namespace; a direct Windows filesystem probe reproduced ENOENT before this fix.
- Decode RPC streams incrementally so UTF-8 characters survive network chunk boundaries in both directions.
- Add writable-lock and deliberately fragmented Unicode RPC regression checks.

## v1.5.0

- Review stable upstream dependencies: use @types/node 26.6.5, retain stable xterm 6.0.0/TypeScript 7.0.2, and document the intentional prebuilt-native package exception.

- Preserve raw and rendered output across bounded reads, including UTF-8 characters and long lines. Use absolute raw byte cursors and report eviction gaps.
- Add offline doctor/version reporting, including the running daemon version and native PTY availability.
- Support subcommand help, global owner flags, options before session ids, trailing RPC timeouts, and the explicit --rpc-timeout-ms spelling.
- Add machine-readable start/list output and owner/live-session filters; improve ownership errors without weakening isolation.
- Keep raw stdout byte-exact and add pagination, Unicode, privilege and CLI integration regressions.
