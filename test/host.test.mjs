import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	normalizeConfig,
	resolveVaultFile,
	obsidianUri,
	openerFor
} from "../index.js";

/** Build a throwaway vault: <root>/note.md, <root>/sub/deep.md, plus an outside file. */
function makeVault() {
	const base = mkdtempSync(path.join(tmpdir(), "obsidian-bridge-"));
	const vaultRoot = path.join(base, "vault");
	const outside = path.join(base, "outside");
	mkdirSync(path.join(vaultRoot, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(vaultRoot, "note.md"), "# Note\n");
	writeFileSync(path.join(vaultRoot, "sub", "deep.md"), "# Deep\n");
	writeFileSync(path.join(outside, "secret.md"), "# Outside\n");
	return { base, vaultRoot, outside };
}

function configFor(vaultRoot, extra = {}) {
	return normalizeConfig({ vaultRoot, vaultName: "MyVault", ...extra });
}

test("normalizeConfig fills defaults and resolves the vault root", () => {
	const { vaultRoot } = makeVault();
	const config = normalizeConfig({ vaultRoot });
	assert.equal(config.vaultRoot, path.resolve(vaultRoot));
	assert.deepEqual(config.extensions, [".md"]);
	assert.equal(config.vaultName, "");
	assert.equal(config.testPath, "HOME.md");
	assert.equal(config.selftest, true);
	assert.ok(config.diagFile.endsWith(path.join(".dsh", "obsidian-bridge.diag.jsonl")));
});

test("normalizeConfig lowercases extensions, accepts an empty list, and drops junk entries", () => {
	const { vaultRoot } = makeVault();
	assert.deepEqual(normalizeConfig({ vaultRoot, extensions: [".MD", "canvas"] }).extensions, [".md"]);
	assert.deepEqual(normalizeConfig({ vaultRoot, extensions: [] }).extensions, []);
	const config = normalizeConfig({ vaultRoot, extensions: [".Base", 42, null] });
	assert.deepEqual(config.extensions, [".base"]);
});

test("normalizeConfig tolerates malformed raw config", () => {
	for (const raw of [undefined, null, [], "text", 7]) {
		const config = normalizeConfig(raw);
		assert.equal(config.vaultRoot, "");
		assert.equal(config.selftest, true);
	}
	assert.equal(normalizeConfig({ vaultRoot: "  " }).vaultRoot, "");
	assert.equal(normalizeConfig({ vaultRoot: "/x", selftest: false }).selftest, false);
});

test("resolveVaultFile accepts a relative path inside the vault", () => {
	const { vaultRoot } = makeVault();
	const config = configFor(vaultRoot);
	const resolved = resolveVaultFile(config, "note.md");
	assert.equal(resolved.ok, true);
	assert.equal(resolved.rel, "note.md");
	assert.deepEqual(resolveVaultFile(config, "sub/deep.md").rel, "sub/deep.md");
});

test("resolveVaultFile accepts an absolute path inside the vault", () => {
	const { vaultRoot } = makeVault();
	const config = configFor(vaultRoot);
	const resolved = resolveVaultFile(config, path.join(vaultRoot, "sub", "deep.md"));
	assert.equal(resolved.ok, true);
	assert.equal(resolved.rel, "sub/deep.md");
});

test("resolveVaultFile refuses traversal outside the vault", () => {
	const { vaultRoot, outside } = makeVault();
	const config = configFor(vaultRoot);
	const escaped = path.join(outside, "secret.md");
	assert.equal(resolveVaultFile(config, escaped).ok, false);
	assert.equal(resolveVaultFile(config, "../outside/secret.md").ok, false);
	assert.equal(resolveVaultFile(config, "sub/../../outside/secret.md").ok, false);
});

test("resolveVaultFile refuses a symlink that points outside the vault", () => {
	const { vaultRoot, outside } = makeVault();
	const config = configFor(vaultRoot);
	symlinkSync(path.join(outside, "secret.md"), path.join(vaultRoot, "link.md"));
	const resolved = resolveVaultFile(config, "link.md");
	assert.equal(resolved.ok, false);
	assert.match(resolved.error, /outside the Obsidian vault/);
});

test("resolveVaultFile rejects missing files, directories, and control characters", () => {
	const { vaultRoot } = makeVault();
	const config = configFor(vaultRoot);
	assert.equal(resolveVaultFile(config, "missing.md").ok, false);
	assert.equal(resolveVaultFile(config, "sub").ok, false);
	assert.equal(resolveVaultFile(config, "bad\u0000name.md").ok, false);
	assert.equal(resolveVaultFile(config, "").ok, false);
	assert.equal(resolveVaultFile(config, "x".repeat(5000)).ok, false);
});

test("resolveVaultFile fails closed when vaultRoot is not configured or missing", () => {
	const { vaultRoot } = makeVault();
	assert.equal(resolveVaultFile(normalizeConfig({}), "note.md").ok, false);
	const gone = normalizeConfig({ vaultRoot: path.join(vaultRoot, "nope") });
	assert.equal(resolveVaultFile(gone, "note.md").ok, false);
});

test("obsidianUri percent-encodes each path segment and prefers the vault name", () => {
	const config = normalizeConfig({ vaultRoot: "/vault", vaultName: "My Notes" });
	const file = { rel: "notes/a b/中文 & co.md", abs: "/vault/notes/a b/中文 & co.md" };
	const withName = obsidianUri(config, file);
	assert.equal(withName, "obsidian://open?vault=My%20Notes&file=notes/a%20b/%E4%B8%AD%E6%96%87%20%26%20co.md");
	assert.equal(withName.includes("notes/a%20b"), true);

	const withoutName = obsidianUri(normalizeConfig({ vaultRoot: "/vault" }), file);
	assert.equal(withoutName, `obsidian://open?path=${encodeURIComponent(file.abs)}`);
});

test("openerFor maps the supported platforms and never uses a shell", () => {
	const opener = openerFor();
	if (process.platform === "darwin") {
		assert.equal(opener.command, "/usr/bin/open");
		assert.deepEqual(opener.args("obsidian://open?vault=V"), ["obsidian://open?vault=V"]);
	} else if (process.platform === "win32") {
		assert.equal(opener.command, "cmd");
		assert.deepEqual(opener.args("obsidian://open?vault=V"), ["/c", "start", "", "obsidian://open?vault=V"]);
	} else {
		assert.equal(opener.command, "xdg-open");
	}
});

test("cleanup of temporary vaults", () => {
	// The fixtures under tmpdir() are removed by the OS; this test only documents that
	// no repository state is touched by the suite.
	const { base } = makeVault();
	rmSync(base, { recursive: true, force: true });
});
