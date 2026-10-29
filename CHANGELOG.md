# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-29

First public release. The plugin was written and used locally before this date; 0.1.0 is
the curated, de-personalised version of that code.

### Added

- Host half (`index.js`): authenticated `GET /obsidian-bridge/config`,
  `POST /obsidian-bridge/open`, `POST /obsidian-bridge/diag` routes, plus the
  `open_in_obsidian` model tool that shares the same open operation.
- Client half (`client.js`): wraps `ctx.sidebarRight.openResource` so a plain click on a
  vault file reference opens Obsidian, while Cmd/Ctrl-click keeps the in-app preview.
- Path containment for every open: realpath + `path.relative` check refuses traversal,
  symlinks that leave the vault, directories, and control characters in paths.
- Fail-closed authentication: all routes go through `connection.requestRejection`, and the
  plugin refuses to serve anything when the connection service is absent (503).
- First-load end-to-end self-test, guarded by `localStorage`, and a JSONL diagnostic log.
- Platform openers: `/usr/bin/open` (macOS), `cmd /c start` (Windows), `xdg-open` (Linux),
  always invoked with an argument vector, never through a shell.
- Unit tests for config normalisation, path containment, URI encoding, and openers
  (`npm test`), plus GitHub Actions CI on Node 20/22/24.

[0.1.0]: https://github.com/Wang-Chuming/dsh-obsidian-bridge/releases/tag/v0.1.0
