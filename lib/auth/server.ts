import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthServerInfo } from "../types.js";
import { OAUTH_SERVER, PLUGIN_NAME } from "../constants.js";

// Resolve path to oauth-success.html (one level up from auth/ subfolder)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const successHtml = fs.readFileSync(path.join(__dirname, "..", "oauth-success.html"), "utf-8");

/**
 * Start a small local HTTP server that waits for /auth/callback and returns the code
 * @param options - OAuth state for validation
 * @returns Promise that resolves to server info
 */
export function startLocalOAuthServer({ state }: { state: string }): Promise<OAuthServerInfo> {
	const server = http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.end("State mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.end("Missing authorization code");
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(successHtml);
			(server as http.Server & { _lastCode?: string })._lastCode = code;
		} catch (error) {
			console.error(`[${PLUGIN_NAME}] OAuth callback handler error:`, error);
			res.statusCode = 500;
			res.end("Internal error");
		}
	});

	return new Promise((resolve) => {
		server
			.listen(OAUTH_SERVER.PORT, "127.0.0.1", () => {
				resolve({
					port: OAUTH_SERVER.PORT,
					ready: true,
					close: () => server.close(),
					waitForCode: async () => {
						const poll = () => new Promise<void>((r) => setTimeout(r, OAUTH_SERVER.POLL_INTERVAL_MS));
						for (let i = 0; i < OAUTH_SERVER.MAX_POLL_ITERATIONS; i++) {
							const lastCode = (server as http.Server & { _lastCode?: string })._lastCode;
							if (lastCode) return { code: lastCode };
							await poll();
						}
						return null;
					},
				});
			})
			.on("error", (err: NodeJS.ErrnoException) => {
				console.error(
					`[${PLUGIN_NAME}] Failed to bind http://127.0.0.1:${OAUTH_SERVER.PORT} (`,
					err?.code,
					") Falling back to manual paste.",
				);
				resolve({
					port: OAUTH_SERVER.PORT,
					ready: false,
					close: () => {
						try {
							server.close();
						} catch (closeErr) {
							console.error(`[${PLUGIN_NAME}] Error closing server:`, closeErr);
						}
					},
					waitForCode: async () => null,
			});
		});
	});
}
