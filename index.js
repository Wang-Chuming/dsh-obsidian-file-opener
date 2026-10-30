// @dsh-external/dsh-obsidian-file-opener — Host half.
//
// The bridge "DSH Web GUI -> Obsidian" has three pieces:
//   1. GET  /obsidian-file-opener/config  (authenticated) -> the vault bridge config the Web client reads;
//   2. POST /obsidian-file-opener/open    (authenticated) -> open one vault file in the Obsidian app;
//   3. POST /obsidian-file-opener/diag    (authenticated) -> append one diagnostic JSON line.
// and the model tool `open_vault_file`, which performs the same open operation
// when a user asks the agent to jump to a note.
//
// The Web client half (client.js) wraps `ctx.sidebarRight.openResource`: a normal
// click on a file reference in the conversation reaches the open route instead of
// the in-app document preview, so one click lands in the Obsidian vault.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_ROUTE = "/obsidian-file-opener/config";
const OPEN_ROUTE = "/obsidian-file-opener/open";
const DIAG_ROUTE = "/obsidian-file-opener/diag";
const MAX_BODY_BYTES = 64 * 1024;
const OPEN_SETTLE_MS = 1500;
const DEFAULT_EXTENSIONS = [".md"];
const DEFAULT_DIAG_FILE = path.join(homedir(), ".dsh", "obsidian-file-opener.diag.jsonl");
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "obsidian-file-opener.config.json");
const CONFIG_FILE_ENV = "DSH_OBSIDIAN_FILE_OPENER_CONFIG";
/** Apps a configured opener rule may launch. Everything else stays on the Obsidian path. */
const SUPPORTED_APPS = new Set(["vscode"]);

/** A plain object, or an empty one for anything else. */
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Expand a leading `~` so JSON-config paths behave like shell paths. */
function expandHome(text) {
	const value = text.trim();
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
	return value;
}

/** Resolve one path field; empty strings and non-strings mean "not set". */
function resolvePath(value, fallback) {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	return path.resolve(expandHome(value));
}

/** Which config file to read: the bundle row's `configFile`, then the env var, then the ~/.dsh default. */
function resolveConfigFile(row) {
	if (typeof row.configFile === "string" && row.configFile.trim() !== "") return path.resolve(expandHome(row.configFile));
	const fromEnv = process.env[CONFIG_FILE_ENV];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return path.resolve(expandHome(fromEnv));
	return DEFAULT_CONFIG_FILE;
}

/** Read the user-level JSON config; a missing, malformed or non-object file yields no overrides. */
function readConfigFile(file) {
	try {
		return asRecord(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return {};
	}
}

/** One field's value: the bundle row's explicit value wins, then the config file, then the default. */
function pickField(row, file, key, fallback) {
	if (row[key] !== undefined) return row[key];
	if (file[key] !== undefined) return file[key];
	return fallback;
}

/**
 * Validate the `openers` rule list: each rule needs at least one extension and a supported
 * app. `root` is optional and means "open the app with this folder as the workspace"; a
 * relative root is resolved against the vault root, so `"physics/…/manuscript"` works.
 */
function buildOpeners(rawOpeners, vaultRoot) {
	if (!Array.isArray(rawOpeners)) return [];
	const rules = [];
	for (const rawRule of rawOpeners) {
		const rule = asRecord(rawRule);
		const extensions = Array.isArray(rule.extensions)
			? rule.extensions
				.filter((extension) => typeof extension === "string" && extension.startsWith("."))
				.map((extension) => extension.toLowerCase())
			: [];
		const app = typeof rule.app === "string" ? rule.app.trim().toLowerCase() : "";
		if (extensions.length === 0 || !SUPPORTED_APPS.has(app)) continue;
		const root = typeof rule.root === "string" && rule.root.trim() !== ""
			? path.resolve(vaultRoot === "" ? process.cwd() : vaultRoot, expandHome(rule.root))
			: "";
		rules.push({ app, extensions, root });
	}
	return rules;
}

/** Build the effective config from an already-read bundle row and config-file body. */
function buildConfig(rawRow, rawFile, configFile) {
	const row = asRecord(rawRow);
	const file = asRecord(rawFile);
	const vaultName = pickField(row, file, "vaultName", "");
	const extensions = pickField(row, file, "extensions", DEFAULT_EXTENSIONS);
	const testPath = pickField(row, file, "testPath", "HOME.md");
	const vaultRoot = resolvePath(pickField(row, file, "vaultRoot", ""), "");
	return {
		vaultRoot,
		vaultName: typeof vaultName === "string" ? vaultName : "",
		extensions: Array.isArray(extensions)
			? extensions
				.filter((entry) => typeof entry === "string" && entry.startsWith("."))
				.map((entry) => entry.toLowerCase())
			: DEFAULT_EXTENSIONS,
		openers: buildOpeners(pickField(row, file, "openers", []), vaultRoot),
		testPath: typeof testPath === "string" && testPath !== "" ? testPath : "HOME.md",
		diagFile: resolvePath(pickField(row, file, "diagFile", DEFAULT_DIAG_FILE), DEFAULT_DIAG_FILE),
		selftest: pickField(row, file, "selftest", true) !== false,
		configFile
	};
}

/**
 * Resolve the effective config from the bundle row (the package exports no Config
 * schema, so the row passes its config through) and the user-level JSON file.
 * `fileValue` is for tests: pass `{}` to stay hermetic, omit it to read the real file.
 */
function normalizeConfig(raw, fileValue) {
	const row = asRecord(raw);
	const configFile = resolveConfigFile(row);
	const file = fileValue !== undefined ? asRecord(fileValue) : readConfigFile(configFile);
	return buildConfig(row, file, configFile);
}

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

/** Append one diagnostic line; diagnostics never fail a request. */
function writeDiag(config, entry) {
	try {
		mkdirSync(path.dirname(config.diagFile), { recursive: true });
		appendFileSync(config.diagFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* keep the bridge usable when the diagnostic file is unavailable */
	}
}

/** Bound the request body; returns { value }, { invalid } or { tooLarge }. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			req.resume();
			return { tooLarge: true };
		}
		chunks.push(chunk);
	}
	let value;
	try {
		value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		return { invalid: true };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { invalid: true };
	return { value };
}

/**
 * Ask the composition's connection service for a rejection first: its Host/Origin
 * fence defeats DNS rebinding and cross-site calls, and its browser authentication
 * (the login-token cookie) gates every caller. Fail closed when the gate is absent.
 */
function rejected(ctx, req, res) {
	let connection;
	try {
		connection = ctx.get("connection");
	} catch {
		connection = undefined;
	}
	if (connection === undefined || typeof connection.requestRejection !== "function") {
		res.statusCode = 503;
		res.end();
		return true;
	}
	const rejection = connection.requestRejection(req);
	if (rejection === undefined) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}

/** Resolve one requested path inside the configured vault, refusing escapes and symlinks out. */
function resolveVaultFile(config, requested) {
	if (config.vaultRoot === "") return { ok: false, error: "vaultRoot is not configured for @dsh-external/dsh-obsidian-file-opener" };
	if (typeof requested !== "string" || requested.length === 0 || requested.length > 4096) return { ok: false, error: "path must be a non-empty string" };
	if (/[\u0000-\u001f\u007f]/u.test(requested)) return { ok: false, error: "path contains control characters" };
	const absolute = path.isAbsolute(requested) ? requested : path.join(config.vaultRoot, requested);
	let rootReal;
	let fileReal;
	try {
		rootReal = realpathSync(config.vaultRoot);
	} catch {
		return { ok: false, error: `vault root does not exist: ${config.vaultRoot}` };
	}
	try {
		fileReal = realpathSync(absolute);
	} catch {
		return { ok: false, error: `file does not exist: ${absolute}` };
	}
	const relative = path.relative(rootReal, fileReal);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, error: "path is outside the Obsidian vault" };
	try {
		if (!statSync(fileReal).isFile()) return { ok: false, error: "path is not a regular file" };
	} catch {
		return { ok: false, error: `cannot stat file: ${fileReal}` };
	}
	return { ok: true, abs: fileReal, rel: relative.split(path.sep).join("/") };
}

/** `obsidian://open` URI for one resolved vault file. */
function obsidianUri(config, file) {
	const encodedFile = file.rel.split("/").map((segment) => encodeURIComponent(segment)).join("/");
	if (config.vaultName.trim() !== "") return `obsidian://open?vault=${encodeURIComponent(config.vaultName)}&file=${encodedFile}`;
	return `obsidian://open?path=${encodeURIComponent(file.abs)}`;
}

/** The platform opener for one URI (ARGV only, never a shell string). */
function openerFor() {
	if (process.platform === "darwin") return { command: "/usr/bin/open", args: (target) => [target] };
	if (process.platform === "win32") return { command: "cmd", args: (target) => ["/c", "start", "", target] };
	return { command: "xdg-open", args: (target) => [target] };
}

/** Run one program with an argument vector; ENOENT is reported as `missing` so callers can try the next candidate. */
function runDetached(command, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { detached: true, stdio: "ignore" });
		} catch (error) {
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => finish({ ok: true }), OPEN_SETTLE_MS);
		timer.unref?.();
		child.once("error", (error) => {
			clearTimeout(timer);
			finish(error.code === "ENOENT" ? { ok: false, missing: true, error: `command not found: ${command}` } : { ok: false, error: error.message });
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) finish({ ok: true });
			else finish({ ok: false, error: `opener exited (${code ?? signal})` });
		});
		child.unref?.();
	});
}

/** Launch one URI and report an early failure; a launcher still running when the window closes counts as launched. */
function launchObsidian(uri) {
	const opener = openerFor();
	return runDetached(opener.command, opener.args(uri));
}

/** Candidate `code` executables, most specific first (macOS ships one inside the app bundle). */
function vscodeCandidates(platform = process.platform) {
	if (platform === "darwin") {
		return [
			"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			"/usr/local/bin/code",
			"/opt/homebrew/bin/code",
			"code"
		];
	}
	if (platform === "win32") return ["code.cmd", "code"];
	return ["code", "/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"];
}

/** `code <root> <file>` when the file is inside the rule's root, `code <file>` otherwise. */
function vscodeArgs(rule, file) {
	const args = [];
	const root = rule.root;
	if (root !== "" && (file.abs === root || file.abs.startsWith(`${root}${path.sep}`))) args.push(root);
	args.push(file.abs);
	return args;
}

/** Open one resolved vault file in VS Code, trying the known `code` locations before giving up. */
async function launchVscode(rule, file) {
	const args = vscodeArgs(rule, file);
	for (const command of vscodeCandidates()) {
		const result = await runDetached(command, args);
		if (result.ok || result.missing !== true) return result;
	}
	return {
		ok: false,
		error: "VS Code command not found (macOS: /Applications/Visual Studio Code.app/…/bin/code; install the `code` shell command for other platforms)"
	};
}

/**
 * Which opener owns one resolved vault file: an explicit `openers` rule first (so `.tex` can
 * go to VS Code), then the Obsidian extension list (empty list = every vault file).
 * `undefined` means "no configured opener", i.e. keep the shipped in-app preview.
 */
function pickOpener(config, fileRel) {
	const lower = fileRel.toLowerCase();
	for (const rule of config.openers) {
		if (rule.extensions.some((extension) => lower.endsWith(extension))) return rule;
	}
	const ownsEverything = config.extensions.length === 0;
	if (ownsEverything || config.extensions.some((extension) => lower.endsWith(extension))) return { app: "obsidian" };
	return undefined;
}

/** The one open operation shared by the Web route and the model tool. */
async function openVaultFile(config, requested, source) {
	const resolved = resolveVaultFile(config, requested);
	if (!resolved.ok) {
		writeDiag(config, { event: "open-rejected", source, path: requested, error: resolved.error });
		return { ok: false, error: resolved.error };
	}
	const opener = pickOpener(config, resolved.rel);
	if (opener === undefined) {
		const error = `no opener configured for ${resolved.rel} (add it to \`extensions\` or an \`openers\` rule)`;
		writeDiag(config, { event: "open-rejected", source, path: resolved.abs, error });
		return { ok: false, error };
	}
	const launched = opener.app === "vscode"
		? await launchVscode(opener, resolved)
		: await launchObsidian(obsidianUri(config, resolved));
	writeDiag(config, {
		event: "open",
		source,
		app: opener.app,
		path: resolved.abs,
		file: resolved.rel,
		ok: launched.ok,
		...(launched.error === undefined ? {} : { error: launched.error })
	});
	if (!launched.ok) return { ok: false, app: opener.app, error: launched.error };
	const payload = { ok: true, app: opener.app, file: resolved.rel };
	if (opener.app === "obsidian") payload.uri = obsidianUri(config, resolved);
	else if (opener.root !== "") payload.root = opener.root;
	return payload;
}

/** Register the routes and the model tool. */
function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	writeDiag(config, {
		event: "host-activate",
		vaultRoot: config.vaultRoot,
		vaultName: config.vaultName,
		extensions: config.extensions,
		openers: config.openers.map((rule) => ({ app: rule.app, extensions: rule.extensions, root: rule.root })),
		selftest: config.selftest,
		configFile: config.configFile
	});

	let webServer;
	try {
		webServer = ctx.get("webServer");
	} catch {
		webServer = undefined;
	}
	if (webServer === undefined || typeof webServer.register !== "function") {
		writeDiag(config, { event: "host-error", error: "webServer service is absent; routes not registered" });
		return;
	}

	const configRoute = async (req, res) => {
		if (rejected(ctx, req, res)) return;
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.statusCode = 405;
			res.setHeader("allow", "GET");
			res.end();
			return;
		}
		sendJson(res, 200, {
			ok: config.vaultRoot !== "",
			vaultRoot: config.vaultRoot,
			vaultName: config.vaultName,
			extensions: config.extensions,
			openers: config.openers.map((rule) => ({ app: rule.app, extensions: rule.extensions })),
			selftest: config.selftest,
			testPath: config.testPath,
			configFile: config.configFile
		});
	};

	const openRoute = async (req, res) => {
		if (rejected(ctx, req, res)) return;
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("allow", "POST");
			res.end();
			return;
		}
		const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
		if (contentType !== "application/json") {
			sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			sendJson(res, 400, { ok: false, error: "request body unreadable" });
			return;
		}
		if (body.tooLarge) {
			sendJson(res, 413, { ok: false, error: "request body is too large" });
			return;
		}
		if (body.invalid) {
			sendJson(res, 400, { ok: false, error: "request body must be a JSON object" });
			return;
		}
		const source = typeof body.value.source === "string" ? body.value.source.slice(0, 80) : "web";
		const result = await openVaultFile(config, body.value.path, source);
		sendJson(res, result.ok ? 200 : 422, result);
	};

	const diagRoute = async (req, res) => {
		if (rejected(ctx, req, res)) return;
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("allow", "POST");
			res.end();
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			sendJson(res, 400, { ok: false, error: "request body unreadable" });
			return;
		}
		if (body.tooLarge) {
			sendJson(res, 413, { ok: false, error: "request body is too large" });
			return;
		}
		if (body.invalid) {
			sendJson(res, 400, { ok: false, error: "request body must be a JSON object" });
			return;
		}
		const event = typeof body.value.event === "string" ? body.value.event.slice(0, 80) : "client";
		writeDiag(config, { client: true, ...body.value, event });
		sendJson(res, 200, { ok: true });
	};

	ctx.effect(() => webServer.register({ kind: "exact", path: CONFIG_ROUTE, handler: configRoute }), "obsidian-file-opener: GET config route");
	ctx.effect(() => webServer.register({ kind: "exact", path: OPEN_ROUTE, handler: openRoute }), "obsidian-file-opener: POST open route");
	ctx.effect(() => webServer.register({ kind: "exact", path: DIAG_ROUTE, handler: diagRoute }), "obsidian-file-opener: POST diag route");

	// The model-facing twin of the open route (one operation, two callers).
	try {
		ctx.inject(["tools"], (toolsCtx) => {
			const tools = toolsCtx.get("tools");
			if (tools === undefined || typeof tools.register !== "function") return;
			toolsCtx.effect(() => tools.register({
				name: "open_vault_file",
				description: "Open a file from the user's Obsidian vault in the app configured for it: notes open in the Obsidian app, other configured types (for example `.tex`) open in VS Code with their project folder. Use this when the user asks to see, jump to, or open a file that lives in their vault. `path` may be absolute or relative to the vault root.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Absolute path, or path relative to the Obsidian vault root, of the file to open."
						}
					},
					required: ["path"],
					additionalProperties: false
				},
				output: {
					schema: { type: "string" },
					render: (_args, value) => [{ type: "text", text: String(value) }]
				},
				async execute(args) {
					const result = await openVaultFile(config, args !== null && typeof args === "object" ? args.path : "", "tool");
					if (!result.ok) throw new Error(result.error);
					return `Opened ${result.file} in ${result.app === "vscode" ? "VS Code" : "Obsidian"}.`;
				}
			}), "obsidian-file-opener: open_vault_file tool");
		});
	} catch (error) {
		writeDiag(config, { event: "host-error", error: `tool registration failed: ${error instanceof Error ? error.message : String(error)}` });
	}
}

export default {
	name: "obsidian-file-opener",
	inject: ["webServer", "connection"],
	apply
};

// Internal helpers, re-exported so the test suite can exercise them without a running Harness.
// They are not part of the plugin's stable public surface.
export { normalizeConfig, buildConfig, readConfigFile, resolveVaultFile, obsidianUri, openerFor, pickOpener, vscodeArgs, vscodeCandidates };
