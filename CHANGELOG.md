# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-29

Makes the plugin installable from a URL: the bundle patch is now part of the package, and the
vault path moved out of the package into a user-level config file.

### Added

- `~/.dsh/obsidian-bridge.config.json` is now the primary configuration surface. The Host half
  reads it at startup when the bundle row carries no `config:` of its own; a missing, malformed,
  or non-object file simply means "no overrides" and the bridge stays inert.
- `configFile` row field and `DSH_OBSIDIAN_BRIDGE_CONFIG` environment variable select another
  JSON config file.
- `~/` expansion for every path field (`vaultRoot`, `diagFile`, `configFile`).
- Config resolution is exported and unit-tested: `normalizeConfig(raw, fileValue)`,
  `buildConfig(row, file, configFile)`, `readConfigFile(file)`. Row values win over file values
  field by field, which is what makes a profile-level patch override possible.
- `GET /obsidian-bridge/config` now also reports `configFile`, and `host-activate` in the
  diagnostic log records it.

### Changed

- The packaged `cordis.patch.yml` is tracked in the repository and ships **without** `config:`,
  so updates never overwrite user settings.
- The install instructions use `dsh plugin add github:…` (or the app's plugin manager); the
  clone-and-link flow is kept for plugin development.
- `cordis.patch.example.yml` is now only the inline-config reference.

### Fixed

- Source installs — `dsh plugin add github:Wang-Chuming/dsh-obsidian-bridge`, the Desktop plugin
  manager, and plugin markets that install from the repository — no longer fail on a missing
  `cordis.patch.yml`; the file the manifest points at is now in the repository.
- The test suite is hermetic: it no longer reads the machine's real config file, and it now
  asserts that the package's declared bundle patch exists in the repository.

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

[0.2.0]: https://github.com/Wang-Chuming/dsh-obsidian-bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/Wang-Chuming/dsh-obsidian-bridge/releases/tag/v0.1.0
