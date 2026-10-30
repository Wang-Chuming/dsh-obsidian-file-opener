# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-30

Adds per-file-type routing: vault files can now open in a configured app instead of Obsidian or
the in-app preview. First supported app: VS Code.

### Added

- `openers` config rules — `{ app, extensions, root? }`. A rule wins over `extensions`, so `.tex`
  can go to VS Code while notes stay in Obsidian. When `root` is set and the clicked file lives
  inside it, the folder is opened as the VS Code workspace too, so LaTeX Workshop resolves the
  real project.
- `app` accepts only a fixed launcher set (currently `vscode`) — the config cannot turn into
  arbitrary command execution. VS Code is started through its `code` CLI (macOS app bundle
  first, then `/usr/local/bin`, `/opt/homebrew/bin`, then `PATH`).
- `open_vault_file` model tool (renamed from `open_in_obsidian`) now follows the same routing and
  names the app it used in its reply.
- `GET /obsidian-file-opener/config` also reports the `openers` rules, so the client can decide
  which clicks to take away from the in-app preview.
- Tests for opener validation, routing precedence, VS Code argument building and platform
  candidate lookup (21 tests).

### Changed

- The client gate redirects a vault file when it matches an `openers` rule or the note
  `extensions`; everything else keeps the in-app preview.

## [0.3.0] - 2026-10-30

Renamed from `dsh-obsidian-bridge` to `dsh-obsidian-file-opener`. The old name read like the
IM channel bridges (WeChat/Telegram), which let another app drive DSH; this plugin does the
opposite — a click in DSH opens a vault note in Obsidian. `file opener` matches the existing
`dsh-file-opener` family and says what it does. Behaviour is unchanged.

### Changed (breaking)

- Repository and package: `Wang-Chuming/dsh-obsidian-bridge` →
  `Wang-Chuming/dsh-obsidian-file-opener`; `@dsh-external/dsh-obsidian-bridge` →
  `@dsh-external/dsh-obsidian-file-opener`.
- Bundle row id `obsidian-bridge` → `obsidian-file-opener`.
- Routes `/obsidian-bridge/*` → `/obsidian-file-opener/*` (host and client halves ship together,
  so the rename is atomic).
- Config file `~/.dsh/obsidian-bridge.config.json` → `~/.dsh/obsidian-file-opener.config.json`;
  environment variable `DSH_OBSIDIAN_BRIDGE_CONFIG` → `DSH_OBSIDIAN_FILE_OPENER_CONFIG`.
- Diagnostic log `~/.dsh/obsidian-bridge.diag.jsonl` → `~/.dsh/obsidian-file-opener.diag.jsonl`.
- Client self-test `localStorage` key moved to the new namespace.

### Migrating from 0.2.0

1. Move the config file to the new name (or let the plugin stay inert until you re-create it).
2. In the profile's `package.json`, rename the dependency entry and its `dsh.profile.bundles` entry.
3. Run `pnpm install` in the profile directory and restart the Harness.

The `open_in_obsidian` tool name and all behaviour are unchanged.

## [0.2.0] - 2026-10-29

Makes the plugin installable from a URL: the bundle patch is now part of the package, and the
vault path moved out of the package into a user-level config file.

### Added

- `~/.dsh/obsidian-file-opener.config.json` is now the primary configuration surface. The Host half
  reads it at startup when the bundle row carries no `config:` of its own; a missing, malformed,
  or non-object file simply means "no overrides" and the bridge stays inert.
- `configFile` row field and `DSH_OBSIDIAN_FILE_OPENER_CONFIG` environment variable select another
  JSON config file.
- `~/` expansion for every path field (`vaultRoot`, `diagFile`, `configFile`).
- Config resolution is exported and unit-tested: `normalizeConfig(raw, fileValue)`,
  `buildConfig(row, file, configFile)`, `readConfigFile(file)`. Row values win over file values
  field by field, which is what makes a profile-level patch override possible.
- `GET /obsidian-file-opener/config` now also reports `configFile`, and `host-activate` in the
  diagnostic log records it.

### Changed

- The packaged `cordis.patch.yml` is tracked in the repository and ships **without** `config:`,
  so updates never overwrite user settings.
- The install instructions use `dsh plugin add github:…` (or the app's plugin manager); the
  clone-and-link flow is kept for plugin development.
- `cordis.patch.example.yml` is now only the inline-config reference.

### Fixed

- Source installs — `dsh plugin add github:Wang-Chuming/dsh-obsidian-file-opener`, the Desktop plugin
  manager, and plugin markets that install from the repository — no longer fail on a missing
  `cordis.patch.yml`; the file the manifest points at is now in the repository.
- The test suite is hermetic: it no longer reads the machine's real config file, and it now
  asserts that the package's declared bundle patch exists in the repository.

## [0.1.0] - 2026-10-29

First public release. The plugin was written and used locally before this date; 0.1.0 is
the curated, de-personalised version of that code.

### Added

- Host half (`index.js`): authenticated `GET /obsidian-file-opener/config`,
  `POST /obsidian-file-opener/open`, `POST /obsidian-file-opener/diag` routes, plus the
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

[0.4.0]: https://github.com/Wang-Chuming/dsh-obsidian-file-opener/releases/tag/v0.4.0
[0.3.0]: https://github.com/Wang-Chuming/dsh-obsidian-file-opener/releases/tag/v0.3.0
[0.2.0]: https://github.com/Wang-Chuming/dsh-obsidian-file-opener/releases/tag/v0.2.0
[0.1.0]: https://github.com/Wang-Chuming/dsh-obsidian-file-opener/releases/tag/v0.1.0
