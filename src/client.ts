// Forward WebSocket client for OneBot 11 (ported from nota-onebot
// crates/nota-onebot/src/client.rs + api.rs). The bot connects to the OneBot
// implementation's WS server (NapCat / LLOneBot / Lagrange), receives
// `post_type` events, and sends action requests over the same connection.
// Reconnects with exponential backoff; the backoff resets after a connection
// stays up for a while.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { OneBotAction, OneBotPostEvent, OneBotResponse } from "./protocol.ts";

/** How long one correlated action call waits for its response. */
const ACTION_TIMEOUT_MS = 15_000;
/** A connection surviving this long is considered healthy; backoff resets. */
const STABLE_CONNECTION_MS = 30_000;
/** Reconnect backoff ceiling. */
const MAX_BACKOFF_MS = 30_000;

/** Minimal logger surface accepted by the client (`ctx.logger("onebot")` fits). */
export interface OneBotLog {
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	debug?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

/** One registered correlated call, keyed by its echo. */
interface PendingCall {
	resolve: (value: OneBotResponse) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * OneBot 11 forward-WebSocket client with a correlated action API.
 */
export class OneBotClient {
	readonly wsUrl: string;
	readonly accessToken: string;

	private readonly log: OneBotLog;
	private socket: WebSocket | null = null;
	private stopped = false;
	private messageHandler: ((event: OneBotPostEvent) => void) | null = null;
	private readonly pending = new Map<string, PendingCall>();
	private backoff = 1000;

	/**
	 * @param options.wsUrl - forward WS URL of the OneBot implementation
	 *   (e.g. `ws://127.0.0.1:3001`).
	 * @param options.accessToken - optional token sent as
	 *   `Authorization: Bearer <token>`.
	 * @param options.log - logger with optional info/warn/debug/error methods.
	 */
	constructor({ wsUrl, accessToken, log }: { wsUrl: string; accessToken?: string; log?: OneBotLog }) {
		this.wsUrl = wsUrl;
		this.accessToken = accessToken ?? "";
		this.log = log ?? console;
	}

	/** Whether the socket is currently open. */
	isConnected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	/** Register the inbound event handler (receives parsed JSON objects). */
	onMessage(handler: (event: OneBotPostEvent) => void): void {
		this.messageHandler = handler;
	}

	/** Start (or restart) the connection loop. */
	start(): void {
		this.stopped = false;
		this.connectLoop();
	}

	/** Stop the client: force-close the socket and reject every pending call. */
	stop(): void {
		this.stopped = true;
		if (this.socket) {
			try {
				// terminate(): immediate TCP close — no closing-handshake wait,
				// so shutdown and tests never hang on a peer that lingers.
				this.socket.terminate();
			} catch {
				// ignore
			}
			this.socket = null;
		}
		this.failPending(new Error("onebot: client stopped"));
	}

	/** Run one connection attempt; schedule the next on close. */
	private connectLoop(): void {
		if (this.stopped) return;
		const startedAt = Date.now();
		const ws = new WebSocket(
			this.wsUrl,
			this.accessToken
				? { headers: { Authorization: `Bearer ${this.accessToken}` } }
				: undefined,
		);
		this.socket = ws;

		ws.on("open", () => {
			this.log.info?.(`onebot: connected to ${this.wsUrl}`);
		});
		ws.on("message", (data) => {
			this.handleMessage(String(data));
		});
		ws.on("close", () => {
			this.socket = null;
			this.failPending(new Error("onebot: connection closed"));
			const stable = Date.now() - startedAt >= STABLE_CONNECTION_MS;
			const backoff = stable ? 1000 : this.backoff;
			this.backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			this.log.warn?.(`onebot: disconnected; reconnecting in ${backoff}ms`);
			if (!this.stopped) setTimeout(() => this.connectLoop(), backoff);
		});
		ws.on("error", (err) => {
			this.log.warn?.(`onebot: websocket error: ${err.message}`);
		});
	}

	/** Dispatch one inbound WS text frame: event or correlated response. */
	private handleMessage(text: string): void {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			this.log.warn?.(`onebot: unrecognized message: ${text.slice(0, 200)}`);
			return;
		}
		if (typeof json !== "object" || json === null) return;
		const record = json as Record<string, unknown>;
		if (typeof record.post_type === "string") {
			this.messageHandler?.(record as OneBotPostEvent);
			return;
		}
		if (typeof record.echo === "string") {
			const waiter = this.pending.get(record.echo);
			if (waiter) {
				this.pending.delete(record.echo);
				clearTimeout(waiter.timer);
				waiter.resolve(record as OneBotResponse);
			}
			return;
		}
		this.log.debug?.(`onebot: message without waiter: ${text.slice(0, 200)}`);
	}

	/**
	 * Send an action and await the implementation's response, matched by
	 * `echo`. Rejects immediately when disconnected, or after the 15s
	 * timeout.
	 */
	call(action: OneBotAction): Promise<OneBotResponse> {
		return new Promise((resolve, reject) => {
			if (!this.isConnected()) {
				reject(new Error("onebot: not connected"));
				return;
			}
			const echo = action.echo ?? randomUUID();
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`onebot: action '${action.action}' timed out after ${ACTION_TIMEOUT_MS}ms`));
			}, ACTION_TIMEOUT_MS);
			this.pending.set(echo, { resolve, reject, timer });
			try {
				this.socket!.send(JSON.stringify({ ...action, echo }));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(echo);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Fire-and-forget action (outbound messages). Returns `false` and logs a
	 * warning when the socket is not open.
	 */
	sendAction(action: OneBotAction): boolean {
		if (!this.isConnected()) {
			this.log.warn?.("onebot: dropped action while disconnected");
			return false;
		}
		try {
			this.socket!.send(JSON.stringify(action));
			return true;
		} catch (err) {
			this.log.warn?.(`onebot: send failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Reject every pending correlated call (connection lost / stopped). */
	private failPending(error: Error): void {
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}
}
