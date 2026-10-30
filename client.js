// @dsh-external/dsh-obsidian-file-opener — Client half (browser, plain ESM-in-loader form).
//
// It wraps `ctx.sidebarRight.openResource`, the single navigation controller every
// file-open path in the Web GUI goes through (conversation markdown file links,
// tool-row path links, inline file mentions, @file references, the file tree).
//
//   plain click on a vault file  -> POST /obsidian-file-opener/open -> Obsidian app
//   Cmd/Ctrl-click               -> the shipped in-app document preview
//   anything outside the vault   -> the shipped in-app document preview
//
// One first-run self-test exercises the whole chain once (guarded by localStorage)
// so the channel is verified end-to-end and diagnosed in ~/.dsh/obsidian-file-opener.diag.jsonl.
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-obsidian-file-opener",
	factory: () => {
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
		const CONFIG_ROUTE = "/obsidian-file-opener/config";
		const OPEN_ROUTE = "/obsidian-file-opener/open";
		const DIAG_ROUTE = "/obsidian-file-opener/diag";
		const SELFTEST_KEY = "dsh-obsidian-file-opener.selftest.v1";
		const GESTURE_WINDOW_MS = 600;

		let config;
		let configPromise;
		let gesture;
		let forcedRedirect = false;
		let wrappedRef;
		let cleanup;

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function postJson(route, payload) {
			return fetch(route, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			}).then(async (response) => {
				let body;
				try {
					body = await response.json();
				} catch {
					body = undefined;
				}
				return { ok: response.ok, status: response.status, body };
			});
		}

		function diag(event, extra) {
			try {
				postJson(DIAG_ROUTE, { ...(extra ?? {}), event }).catch(() => {});
			} catch {
				/* diagnostics never disturb the UI */
			}
		}

		function markGesture(event) {
			gesture = {
				at: Date.now(),
				meta: event.metaKey === true || event.ctrlKey === true
			};
		}

		/** Parse a `dsh-resource://file/…` address into its scope and path. */
		function parseFileAddress(address) {
			try {
				if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
				const end = address.search(/[?#]/);
				const parts = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split("/");
				const scope = parts.shift();
				if (scope === "session") {
					const sessionId = decodeURIComponent(parts.shift() ?? "");
					if (sessionId === "" || parts.length === 0) return undefined;
					return { scope: "session", sessionId, path: parts.map((segment) => decodeURIComponent(segment)).join("/") };
				}
				if (scope === "absolute") {
					const unc = parts[0] === "" && parts.length > 1;
					const segments = (unc ? parts.slice(1) : parts).map((segment) => decodeURIComponent(segment));
					if (segments.length === 0 || segments[0] === "") return undefined;
					if (unc) return { scope: "absolute", path: `//${segments.join("/")}` };
					if (/^[A-Za-z]:$/.test(segments[0])) return { scope: "absolute", path: segments.join("/") };
					return { scope: "absolute", path: `/${segments.join("/")}` };
				}
			} catch {
				return undefined;
			}
			return undefined;
		}

		function sessionCwd(sessions, sessionId) {
			try {
				const snapshot = sessions?.list?.getSnapshot?.();
				return snapshot?.byId?.[sessionId]?.cwd;
			} catch {
				return undefined;
			}
		}

		/** Absolute filesystem path one address names, or undefined when the session workspace is unknown. */
		function absoluteFor(sessions, parsed) {
			if (parsed.scope === "absolute") return parsed.path;
			const cwd = sessionCwd(sessions, parsed.sessionId);
			if (typeof cwd !== "string" || cwd === "") return undefined;
			const value = parsed.path;
			if (value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value)) return value;
			return `${cwd.replace(/[/\\]+$/, "")}/${value.replace(/^[/\\]+/, "")}`;
		}

		/** Whether the bridge should take this absolute path away from the in-app preview. */
		function shouldRedirect(absolute) {
			const current = config;
			if (current === undefined || current === null || current.ok !== true) return false;
			if (typeof current.vaultRoot !== "string" || current.vaultRoot === "") return false;
			const root = current.vaultRoot.replace(/\/+$/, "");
			const normalized = absolute.replace(/\\/g, "/");
			if (normalized !== root && !normalized.startsWith(`${root}/`)) return false;
			const extensions = Array.isArray(current.extensions)
				? current.extensions.filter((entry) => typeof entry === "string" && entry.startsWith("."))
				: [];
			if (extensions.length === 0) return true;
			const lower = normalized.toLowerCase();
			return extensions.some((entry) => lower.endsWith(entry.toLowerCase()));
		}

		function loadConfig() {
			if (configPromise === undefined) {
				configPromise = (async () => {
					try {
						const response = await fetch(CONFIG_ROUTE, { headers: { accept: "application/json" } });
						if (!response.ok) {
							config = null;
							return null;
						}
						const body = await response.json();
						config = body !== null && typeof body === "object" ? body : null;
						return config;
					} catch {
						config = null;
						return null;
					}
				})();
			}
			return configPromise;
		}

		function joinVaultPath(root, relative) {
			const base = root.replace(/\/+$/, "");
			const tail = relative.replace(/^\/+/, "");
			return `${base}/${tail}`;
		}

		function absoluteFileAddress(absolute) {
			const segments = absolute.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((segment) => segment !== "");
			return `${FILE_ADDRESS_PREFIX}absolute/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
		}

		function redirectToObsidian(absolute, source, fallback) {
			return postJson(OPEN_ROUTE, { path: absolute, source }).then((result) => {
				if (result.ok && result.body !== undefined && result.body.ok === true) return;
				diag("redirect-failed", {
					path: absolute,
					status: result.status,
					error: result.body !== undefined ? result.body.error : undefined
				});
				fallback();
			}, (error) => {
				diag("redirect-failed", { path: absolute, message: messageOf(error) });
				fallback();
			});
		}

		function selftestAlreadyDone() {
			try {
				return window.localStorage.getItem(SELFTEST_KEY) === "done";
			} catch {
				return true;
			}
		}

		function markSelftestDone() {
			try {
				window.localStorage.setItem(SELFTEST_KEY, "done");
			} catch {
				/* private mode: the self-test repeats on the next load, which is harmless */
			}
		}

		/** First-run end-to-end probe: call the wrapped controller exactly like a click would. */
		function runSelftest(controller) {
			if (selftestAlreadyDone()) return;
			loadConfig().then((current) => {
				if (controller.openResource !== wrappedRef) {
					diag("selftest-skipped", { reason: "not-wrapped" });
					return;
				}
				if (current === null || current === undefined || current.ok !== true) {
					diag("selftest-skipped", { reason: "config-unavailable" });
					markSelftestDone();
					return;
				}
				if (current.selftest === false) {
					markSelftestDone();
					return;
				}
				const testRelative = typeof current.testPath === "string" && current.testPath !== "" ? current.testPath : "HOME.md";
				const testAbsolute = joinVaultPath(current.vaultRoot, testRelative);
				diag("selftest-trigger", { path: testAbsolute });
				forcedRedirect = true;
				try {
					controller.openResource(absoluteFileAddress(testAbsolute));
				} catch (error) {
					diag("selftest-error", { message: messageOf(error) });
				} finally {
					forcedRedirect = false;
				}
				markSelftestDone();
			}, (error) => {
				diag("selftest-error", { message: messageOf(error) });
			});
		}

		/** Patch the navigation controller; returns its disposer. */
		function install(controller, sessions) {
			const originalOpenResource = controller.openResource;
			const wrapped = function openResource(address, options) {
				try {
					const fresh = gesture !== undefined && Date.now() - gesture.at < GESTURE_WINDOW_MS;
					const active = forcedRedirect || (fresh && gesture.meta !== true);
					if (active) {
						const parsed = parseFileAddress(address);
						if (parsed !== undefined) {
							const absolute = absoluteFor(sessions, parsed);
							if (absolute !== undefined && shouldRedirect(absolute)) {
								const source = forcedRedirect ? "selftest" : "conversation";
								redirectToObsidian(absolute, source, () => {
									try {
										originalOpenResource.call(controller, address, options);
									} catch (error) {
										diag("fallback-error", { message: messageOf(error) });
									}
								}).catch(() => {});
								return undefined;
							}
						}
					}
				} catch (error) {
					diag("wrap-error", { message: messageOf(error) });
				}
				return originalOpenResource.call(controller, address, options);
			};
			controller.openResource = wrapped;
			wrappedRef = wrapped;
			return () => {
				try {
					if (controller.openResource === wrapped) controller.openResource = originalOpenResource;
				} catch {
					/* restoring is best effort during teardown */
				}
				if (wrappedRef === wrapped) wrappedRef = undefined;
			};
		}

		function apply(ctx) {
			let disposed = false;
			let installed = false;
			let retried = 0;
			let retryTimer;
			try {
				document.addEventListener("click", markGesture, true);
			} catch (error) {
				diag("apply-error", { message: messageOf(error) });
			}
			try {
				ctx.effect(() => () => {
					disposed = true;
					if (retryTimer !== undefined) clearInterval(retryTimer);
					retryTimer = undefined;
					if (cleanup !== undefined) cleanup();
					cleanup = undefined;
				}, "obsidian-file-opener: client cleanup");
			} catch {
				/* the plugin still works without effect-scoped cleanup */
			}

			const installFrom = (scope) => {
				if (disposed || installed) return;
				let controller;
				try {
					controller = scope.get("sidebarRight");
				} catch {
					controller = undefined;
				}
				if (controller === undefined || typeof controller.openResource !== "function") return;
				let sessions;
				try {
					sessions = scope.get("sessions");
				} catch {
					sessions = undefined;
				}
				installed = true;
				if (retryTimer !== undefined) clearInterval(retryTimer);
				retryTimer = undefined;
				try {
					cleanup = install(controller, sessions);
					diag("client-activate", { wrapped: true, hasSessions: sessions !== undefined });
					loadConfig().then((current) => {
						diag("client-config", {
							ok: current !== null && current !== undefined && current.ok === true,
							vaultRoot: current !== null && current !== undefined ? current.vaultRoot : undefined
						});
						runSelftest(controller);
					}, () => {});
				} catch (error) {
					diag("install-error", { message: messageOf(error) });
				}
			};

			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["sidebarRight", "sessions"], (scope) => {
						installFrom(scope);
					});
				}
			} catch (error) {
				diag("inject-error", { message: messageOf(error) });
			}
			try {
				ctx.on("slots/changed", () => {
					if (!installed) installFrom(ctx);
				});
				ctx.on("connection/reset", () => {
					if (!installed) installFrom(ctx);
				});
			} catch {
				/* events are only a fallback for a missing optional injection */
			}
			if (!installed) {
				installFrom(ctx);
				retryTimer = setInterval(() => {
					if (installed || disposed || retried >= 40) {
						if (retryTimer !== undefined) clearInterval(retryTimer);
						retryTimer = undefined;
						return;
					}
					retried += 1;
					installFrom(ctx);
				}, 250);
				retryTimer?.unref?.();
			}
		}

		return {
			name: "@dsh-external/dsh-obsidian-file-opener",
			apply
		};
	}
});
