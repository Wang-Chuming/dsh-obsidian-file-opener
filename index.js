// @dsh-external/dsh-obsidian-bridge — Host half.
//
// The bridge "DSH Web GUI -> Obsidian" has three pieces:
//   1. GET  /obsidian-bridge/config  (authenticated) -> the vault bridge config the Web client reads;
//   2. POST /obsidian-bridge/open    (authenticated) -> open one vault file in the Obsidian app;
//   3. POST /obsidian-bridge/diag    (authenticated) -> append one diagnostic JSON line.
// and the model tool `open_in_obsidian`, which performs the same open operation
// when a user asks the agent to jump to a note.
//
// The Web client half (client.js) wraps `ctx.sidebarRight.openResource`: a normal
// click on a file reference in the conversation reaches the open route instead of
// the in-app document preview, so one click lands in the Obsidian vault.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_ROUTE = "/obsidian-bridge/config";
const OPEN_ROUTE = "/obsidian-bridge/open";
const DIAG_ROUTE = "/obsidian-bridge/diag";
const MAX_BODY_BYTES = 64 * 1024;
const OPEN_SETTLE_MS = 1500;
const DEFAULT_EXTENSIONS = [".md"];
const DEFAULT_DIAG_FILE = path.join(homedir(), ".dsh", "obsidian-bridge.diag.jsonl");

/** Read the bundle row's raw config (the package exports no Config schema, so the row passes it through). */
function normalizeConfig(raw) {
	const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const vaultRoot = typeof value.vaultRoot === "string" && value.vaultRoot.trim() !== ""
		? path.resolve(value.vaultRoot.trim())
		: "";
	const vaultName = typeof value.vaultName === "string" ? value.vaultName : "";
	const extensions = Array.isArray(value.extensions)
		? value.extensions
			.filter((entry) => typeof entry === "string" && entry.startsWith("."))
			.map((entry) => entry.toLowerCase())
		: DEFAULT_EXTENSIONS;
	const testPath = typeof value.testPath === "string" && value.testPath !== "" ? value.testPath : "HOME.md";
	const diagFile = typeof value.diagFile === "string" && value.diagFile !== "" ? path.resolve(value.diagFile) : DEFAULT_DIAG_FILE;
	return {
		vaultRoot,
		vaultName,
		extensions,
		testPath,
		diagFile,
		selftest: value.selftest !== false
	};
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
	if (config.vaultRoot === "") return { ok: false, error: "vaultRoot is not configured for @dsh-external/dsh-obsidian-bridge" };
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

/** Launch one URI and report an early failure; a launcher still running when the window closes counts as launched. */
function launchObsidian(uri) {
	return new Promise((resolve) => {
		const opener = openerFor();
		let child;
		try {
			child = spawn(opener.command, opener.args(uri), { detached: true, stdio: "ignore" });
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
			finish({ ok: false, error: error.message });
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) finish({ ok: true });
			else finish({ ok: false, error: `opener exited (${code ?? signal})` });
		});
		child.unref?.();
	});
}

/** The one open operation shared by the Web route and the model tool. */
async function openInObsidian(config, requested, source) {
	const resolved = resolveVaultFile(config, requested);
	if (!resolved.ok) {
		writeDiag(config, { event: "open-rejected", source, path: requested, error: resolved.error });
		return { ok: false, error: resolved.error };
	}
	const uri = obsidianUri(config, resolved);
	const launched = await launchObsidian(uri);
	writeDiag(config, {
		event: "open",
		source,
		path: resolved.abs,
		file: resolved.rel,
		ok: launched.ok,
		...(launched.error === undefined ? {} : { error: launched.error })
	});
	return launched.ok
		? { ok: true, file: resolved.rel, uri }
		: { ok: false, error: launched.error };
}

/** Register the routes and the model tool. */
function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	writeDiag(config, {
		event: "host-activate",
		vaultRoot: config.vaultRoot,
		vaultName: config.vaultName,
		extensions: config.extensions,
		selftest: config.selftest
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
			selftest: config.selftest,
			testPath: config.testPath
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
		const result = await openInObsidian(config, body.value.path, source);
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

	ctx.effect(() => webServer.register({ kind: "exact", path: CONFIG_ROUTE, handler: configRoute }), "obsidian-bridge: GET config route");
	ctx.effect(() => webServer.register({ kind: "exact", path: OPEN_ROUTE, handler: openRoute }), "obsidian-bridge: POST open route");
	ctx.effect(() => webServer.register({ kind: "exact", path: DIAG_ROUTE, handler: diagRoute }), "obsidian-bridge: POST diag route");

	// The model-facing twin of the open route (one operation, two callers).
	try {
		ctx.inject(["tools"], (toolsCtx) => {
			const tools = toolsCtx.get("tools");
			if (tools === undefined || typeof tools.register !== "function") return;
			toolsCtx.effect(() => tools.register({
				name: "open_in_obsidian",
				description: "Open a file from the user's Obsidian vault in the Obsidian app and bring Obsidian to the front. Use this when the user asks to see, jump to, or open a note that lives in their Obsidian vault. `path` may be absolute or relative to the vault root.",
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
					const result = await openInObsidian(config, args !== null && typeof args === "object" ? args.path : "", "tool");
					if (!result.ok) throw new Error(result.error);
					return `Opened ${result.file} in Obsidian.`;
				}
			}), "obsidian-bridge: open_in_obsidian tool");
		});
	} catch (error) {
		writeDiag(config, { event: "host-error", error: `tool registration failed: ${error instanceof Error ? error.message : String(error)}` });
	}
}

export default {
	name: "obsidian-bridge",
	inject: ["webServer", "connection"],
	apply
};

// Internal helpers, re-exported so the test suite can exercise them without a running Harness.
// They are not part of the plugin's stable public surface.
export { normalizeConfig, resolveVaultFile, obsidianUri, openerFor };
