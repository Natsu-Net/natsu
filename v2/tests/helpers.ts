import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type StartOptions } from "../src/server.ts";
import { clearControllers } from "../src/controller.ts";
import { Router, clearDecoratorRouters } from "../src/router.ts";
import { clearPendingBindings } from "../src/metadata.ts";
import { resetConfig, setConfig, type NatsuConfigInput } from "../src/config.ts";

/** Wipe every global registry and put the config back to a quiet test baseline. */
export function reset(overrides: NatsuConfigInput = {}): void {
	Router.clear();
	clearDecoratorRouters();
	clearControllers();
	clearPendingBindings();
	resetConfig();
	setConfig({
		General: { logFormat: "", logLevel: "silent" },
		Session: { driver: "memory", sweepInterval: 0 },
		Static: { enabled: false },
		...overrides,
	});
}

export interface RunningApp {
	app: Application;
	base: string;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	stop(): Promise<void>;
}

export async function startApp(app: Application, options: StartOptions = {}): Promise<RunningApp> {
	const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true, ...options });
	const base = server.url.origin;
	return {
		app,
		base,
		fetch: (path, init) => fetch(base + path, init),
		stop: () => app.close(true),
	};
}

/** A temp directory that removes itself. */
export function tempDir(prefix = "natsu-test-"): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), prefix));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Send a request byte-for-byte, bypassing fetch()'s URL normalisation — the
 * only way to test what a hostile client can actually put on the wire.
 *
 * Resolution is driven by Content-Length rather than by the socket closing:
 * Bun keeps the connection open after some requests even when the client asked
 * for `Connection: close`, and a test must not hang on that.
 */
export async function rawRequest(base: string, requestLine: string, headers: string[] = [], timeoutMs = 2000): Promise<string> {
	const url = new URL(base);
	const payload = [requestLine, `Host: ${url.host}`, ...headers, "Connection: close", "", ""].join("\r\n");

	return new Promise<string>((resolve, reject) => {
		let received = "";
		let settled = false;
		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(received), timeoutMs);

		const complete = (): boolean => {
			const split = received.indexOf("\r\n\r\n");
			if (split === -1) return false;
			const head = received.slice(0, split);
			const length = /content-length:\s*(\d+)/i.exec(head);
			if (!length?.[1]) return false;
			return received.length - (split + 4) >= Number(length[1]);
		};

		Bun.connect({
			hostname: url.hostname,
			port: Number(url.port),
			socket: {
				open(socket) {
					socket.write(payload);
				},
				data(socket, chunk) {
					received += chunk.toString();
					if (complete()) {
						socket.end();
						finish(received);
					}
				},
				close() {
					finish(received);
				},
				error(_socket, error) {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						reject(error);
					}
				},
			},
		}).catch((error: unknown) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
	});
}
