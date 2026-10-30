import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	normalizeConfig,
	buildConfig,
	readConfigFile,
	resolveVaultFile,
	obsidianUri,
	openerFor,
	pickOpener,
	vscodeArgs,
	vscodeCandidates,
	activationArgs,
	vscodeEnv
} from "../index.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Build a throwaway vault: <root>/note.md, <root>/sub/deep.md, plus an outside file. */
function makeVault() {
	const base = mkdtempSync(path.join(tmpdir(), "obsidian-file-opener-"));
	const vaultRoot = path.join(base, "vault");
	const outside = path.join(base, "outside");
	mkdirSync(path.join(vaultRoot, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(vaultRoot, "note.md"), "# Note\n");
	writeFileSync(path.join(vaultRoot, "sub", "deep.md"), "# Deep\n");
	writeFileSync(path.join(outside, "secret.md"), "# Outside\n");
	return { base, vaultRoot, outside };
}

/** Hermetic config: `{}` keeps the suite from reading the machine's real config file. */
function configFor(vaultRoot, extra = {}) {
	return normalizeConfig({ vaultRoot, vaultName: "MyVault", ...extra }, {});
}

test("normalizeConfig fills defaults and resolves the vault root", () => {
	const { vaultRoot } = makeVault();
	const config = normalizeConfig({ vaultRoot }, {});
	assert.equal(config.vaultRoot, path.resolve(vaultRoot));
	assert.deepEqual(config.extensions, [".md"]);
	assert.equal(config.vaultName, "");
	assert.equal(config.testPath, "HOME.md");
	assert.equal(config.selftest, true);
	assert.ok(config.diagFile.endsWith(path.join(".dsh", "obsidian-file-opener.diag.jsonl")));
	assert.ok(config.configFile.endsWith(path.join(".dsh", "obsidian-file-opener.config.json")));
});

test("normalizeConfig lowercases extensions, accepts an empty list, and drops junk entries", () => {
	const { vaultRoot } = makeVault();
	assert.deepEqual(normalizeConfig({ vaultRoot, extensions: [".MD", "canvas"] }, {}).extensions, [".md"]);
	assert.deepEqual(normalizeConfig({ vaultRoot, extensions: [] }, {}).extensions, []);
	const config = normalizeConfig({ vaultRoot, extensions: [".Base", 42, null] }, {});
	assert.deepEqual(config.extensions, [".base"]);
});

test("normalizeConfig tolerates malformed raw config", () => {
	for (const raw of [undefined, null, [], "text", 7]) {
		const config = normalizeConfig(raw, {});
		assert.equal(config.vaultRoot, "");
		assert.equal(config.selftest, true);
	}
	assert.equal(normalizeConfig({ vaultRoot: "  " }, {}).vaultRoot, "");
	assert.equal(normalizeConfig({ vaultRoot: "/x", selftest: false }, {}).selftest, false);
});

test("buildConfig lets the bundle row override the config file", () => {
	const file = { vaultRoot: "/from-file", vaultName: "FileVault", extensions: [], selftest: false };
	const merged = buildConfig({ vaultRoot: "/from-row" }, file, "/tmp/c.json");
	assert.equal(merged.vaultRoot, path.resolve("/from-row"));
	assert.equal(merged.vaultName, "FileVault");
	assert.deepEqual(merged.extensions, []);
	assert.equal(merged.selftest, false);
});

test("buildConfig fills the row's gaps from the config file", () => {
	const file = { vaultRoot: "~/notes", vaultName: "Notes", testPath: "Inbox.md", diagFile: "~/logs/bridge.jsonl" };
	const merged = buildConfig({}, file, "/tmp/c.json");
	assert.equal(merged.vaultRoot, path.join(homedir(), "notes"));
	assert.equal(merged.vaultName, "Notes");
	assert.equal(merged.testPath, "Inbox.md");
	assert.equal(merged.diagFile, path.join(homedir(), "logs", "bridge.jsonl"));
	assert.equal(merged.selftest, true);
	assert.deepEqual(merged.extensions, [".md"]);
});

test("buildConfig ignores non-string and empty path values", () => {
	const merged = buildConfig({ vaultRoot: 7, extensions: ".md" }, { vaultRoot: "", diagFile: 42 }, "/tmp/c.json");
	assert.equal(merged.vaultRoot, "");
	assert.deepEqual(merged.extensions, [".md"]);
	assert.ok(merged.diagFile.endsWith(path.join(".dsh", "obsidian-file-opener.diag.jsonl")));
});

test("readConfigFile reads a JSON object and refuses anything else", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "obsidian-file-opener-cfg-"));
	const good = path.join(dir, "good.json");
	writeFileSync(good, JSON.stringify({ vaultRoot: "/vault" }));
	assert.deepEqual(readConfigFile(good), { vaultRoot: "/vault" });

	const array = path.join(dir, "array.json");
	writeFileSync(array, "[1,2,3]");
	assert.deepEqual(readConfigFile(array), {});

	const broken = path.join(dir, "broken.json");
	writeFileSync(broken, "{ not json");
	assert.deepEqual(readConfigFile(broken), {});
	assert.deepEqual(readConfigFile(path.join(dir, "missing.json")), {});
});

test("the package declares a bundle patch that exists in the repo (installability)", () => {
	const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
	const patch = manifest.dsh?.bundle?.patch;
	assert.equal(typeof patch, "string");
	const patchFile = path.join(REPO_ROOT, patch);
	assert.equal(existsSync(patchFile), true, `bundle patch ${patch} is missing from the repo`);
	assert.match(readFileSync(patchFile, "utf8"), /id: obsidian-file-opener/);
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
	assert.equal(resolveVaultFile(normalizeConfig({}, {}), "note.md").ok, false);
	const gone = normalizeConfig({ vaultRoot: path.join(vaultRoot, "nope") }, {});
	assert.equal(resolveVaultFile(gone, "note.md").ok, false);
});

test("obsidianUri percent-encodes each path segment and prefers the vault name", () => {
	const config = normalizeConfig({ vaultRoot: "/vault", vaultName: "My Notes" }, {});
	const file = { rel: "notes/a b/中文 & co.md", abs: "/vault/notes/a b/中文 & co.md" };
	const withName = obsidianUri(config, file);
	assert.equal(withName, "obsidian://open?vault=My%20Notes&file=notes/a%20b/%E4%B8%AD%E6%96%87%20%26%20co.md");
	assert.equal(withName.includes("notes/a%20b"), true);

	const withoutName = obsidianUri(normalizeConfig({ vaultRoot: "/vault" }, {}), file);
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

test("buildConfig validates opener rules and resolves their roots", () => {
	const file = {
		vaultRoot: "/vault",
		openers: [
			{ app: "vscode", extensions: [".TEX", ".bib"], root: "physics/paper/manuscript" },
			{ app: "vscode", extensions: [".tex"], root: "~/papers" },
			{ app: "photoshop", extensions: [".psd"] },
			{ app: "vscode", extensions: [] },
			"nonsense"
		]
	};
	const config = buildConfig({}, file, "/tmp/c.json");
	assert.equal(config.openers.length, 2);
	assert.deepEqual(config.openers[0], {
		app: "vscode",
		extensions: [".tex", ".bib"],
		root: path.resolve("/vault", "physics/paper/manuscript")
	});
	assert.deepEqual(config.openers[1], { app: "vscode", extensions: [".tex"], root: path.join(homedir(), "papers") });
	assert.deepEqual(buildConfig({}, { openers: "nope" }, "/tmp/c.json").openers, []);
});

test("pickOpener prefers opener rules, then the note extensions, then gives up", () => {
	const config = buildConfig({}, {
		vaultRoot: "/vault",
		extensions: [".md"],
		openers: [{ app: "vscode", extensions: [".tex"], root: "papers" }]
	}, "/tmp/c.json");
	assert.equal(pickOpener(config, "physics/lshape-pt-symmetry/paper/manuscript/main.tex").app, "vscode");
	assert.equal(pickOpener(config, "notes/Home.md").app, "obsidian");
	assert.equal(pickOpener(config, "figures/plot.pdf"), undefined);

	// An opener rule beats the note list: `.md` can be routed to VS Code too.
	const overridden = buildConfig({}, {
		vaultRoot: "/vault",
		extensions: [".md"],
		openers: [{ app: "vscode", extensions: [".md"] }]
	}, "/tmp/c.json");
	assert.equal(pickOpener(overridden, "notes/Home.md").app, "vscode");

	// Empty extensions means "every vault file goes to Obsidian", as before.
	const everything = buildConfig({}, { vaultRoot: "/vault", extensions: [] }, "/tmp/c.json");
	assert.equal(pickOpener(everything, "figures/plot.pdf").app, "obsidian");
});

test("vscodeArgs opens the rule root as workspace when the file lives inside it", () => {
	const file = { rel: "physics/paper/manuscript/main.tex", abs: "/vault/physics/paper/manuscript/main.tex" };
	assert.deepEqual(
		vscodeArgs({ app: "vscode", extensions: [".tex"], root: "/vault/physics/paper/manuscript" }, file),
		["/vault/physics/paper/manuscript", "/vault/physics/paper/manuscript/main.tex"]
	);
	assert.deepEqual(
		vscodeArgs({ app: "vscode", extensions: [".tex"], root: "/vault/other" }, file),
		["/vault/physics/paper/manuscript/main.tex"]
	);
	assert.deepEqual(
		vscodeArgs({ app: "vscode", extensions: [".tex"], root: "" }, file),
		["/vault/physics/paper/manuscript/main.tex"]
	);
});

test("vscodeCandidates looks inside the macOS app bundle and falls back to PATH", () => {
	assert.equal(vscodeCandidates("darwin")[0], "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
	assert.equal(vscodeCandidates("darwin").includes("code"), true);
	assert.deepEqual(vscodeCandidates("win32").slice(0, 2), ["code.cmd", "code"]);
	assert.equal(vscodeCandidates("linux")[0], "code");
});

test("activationArgs brings VS Code to the front on macOS only", () => {
	assert.deepEqual(activationArgs("darwin"), ["-b", "com.microsoft.VSCode"]);
	assert.equal(activationArgs("linux"), undefined);
	assert.equal(activationArgs("win32"), undefined);
});

test("vscodeEnv drops the inherited Electron run-as-node flags without mutating the source", () => {
	const source = { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", PATH: "/usr/bin", HOME: "/home/you" };
	const env = vscodeEnv(source);
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/you");
	assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});
