# Changelog

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
