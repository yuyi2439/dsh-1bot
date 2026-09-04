// Integration tests for the onebot.js client (the plugin's protocol layer):
// the connect factory resolves only on an established connection, events are
// forwarded, invoke resolves with data and formats failures. Run against a
// local `ws` server, so no live OneBot implementation is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { connect, type OneBotClient, type OneBotLog } from "onebot.js";

const silentLog: OneBotLog = {
	info() {},
	warn() {},
	debug() {},
	error() {},
};

/** Wait until the predicate holds (poll every 10ms). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor: condition not met in time");
}

/** A fake OneBot implementation: answers echoed actions, can push events. */
class FakeOneBotServer {
	readonly wss: WebSocketServer;
	private readonly sockets = new Set<WebSocket>();

	constructor() {
		this.wss = new WebSocketServer({ port: 0 });
		this.wss.on("connection", (ws) => {
			this.sockets.add(ws);
			ws.on("close", () => this.sockets.delete(ws));
		});
	}

	async url(): Promise<string> {
		await new Promise((resolve) => this.wss.once("listening", resolve));
		const address = this.wss.address();
		assert.ok(address && typeof address !== "string");
		return `ws://127.0.0.1:${address.port}`;
	}

	/** The first connected client socket (tests use a single client). */
	get socket(): WebSocket {
		const ws = this.sockets.values().next().value;
		assert.ok(ws, "no client socket connected");
		return ws;
	}

	/** Answer one action frame with a success envelope. */
	reply(frame: Record<string, any>, data: unknown, overrides: Record<string, unknown> = {}): void {
		this.socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data, ...overrides }));
	}

	/** Push one OneBot event (no echo) to every connected client. */
	push(event: Record<string, unknown>): void {
		const body = JSON.stringify(event);
		for (const ws of this.sockets) ws.send(body);
	}

	/** Await the next action frame the client sends. */
	nextFrame(): Promise<Record<string, any>> {
		return new Promise((resolve) => this.socket.once("message", (data) => resolve(JSON.parse(String(data)))));
	}

	async close(): Promise<void> {
		for (const ws of this.sockets) ws.terminate();
		await new Promise((resolve) => this.wss.close(resolve));
	}
}

test("connect resolves on establishment; events forwarded; invoke resolves with data", async (t) => {
	const server = new FakeOneBotServer();
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", log: silentLog });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});

	assert.equal(bot.connected, true);
	const receivedEvents: Array<Record<string, unknown>> = [];
	bot.on("message", (event) => receivedEvents.push(event as unknown as Record<string, unknown>));

	// Server pushes a private message event; the client must forward it.
	server.push({
		post_type: "message",
		message_type: "private",
		sub_type: "friend",
		message_id: 1,
		user_id: 42,
		self_id: 7,
		time: 1700000000,
		message: [{ type: "text", data: { text: "ping" } }],
		message_format: "array",
		sender: { user_id: 42, nickname: "T", card: "" },
	});
	await waitFor(() => receivedEvents.length === 1);
	assert.equal(receivedEvents[0].message_type, "private");

	// Typed correlated call: frame carries action/params/echo; data comes back.
	const framePromise = server.nextFrame();
	const invokePromise = bot.invoke("get_login_info", {});
	const frame = await framePromise;
	assert.equal(frame.action, "get_login_info");
	assert.equal(typeof frame.echo, "string");
	server.reply(frame, { user_id: 7, nickname: "Bot" });
	const data = await invokePromise;
	assert.deepEqual(data, { user_id: 7, nickname: "Bot" });
});

test("invoke accepts a status-only ok answer without retcode (LLOnebot style)", async (t) => {
	const server = new FakeOneBotServer();
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", log: silentLog });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});
	await waitFor(() => bot.connected);

	const framePromise = server.nextFrame();
	const invokePromise = bot.invoke("get_login_info", {});
	const frame = await framePromise;
	// No retcode at all — status "ok" alone must settle the call as success.
	server.socket.send(JSON.stringify({ echo: frame.echo, status: "ok", data: { user_id: 7, nickname: "Bot" } }));
	const data = await invokePromise;
	assert.deepEqual(data, { user_id: 7, nickname: "Bot" });
});

test("invoke formats failures with action, retcode, detail and the hint", async (t) => {
	const server = new FakeOneBotServer();
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", log: silentLog });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});
	await waitFor(() => bot.connected);

	const framePromise = server.nextFrame();
	const invokePromise = bot.invoke("get_friend_msg_history", { user_id: 42, count: 20 }, {
		hint: "use onebot_get_content instead",
	});
	const frame = await framePromise;
	server.reply(frame, null, { status: "failed", retcode: 1404, data: { message: "不支持该接口" } });
	await assert.rejects(
		invokePromise,
		/get_friend_msg_history failed: status=failed retcode=1404, detail="不支持该接口" — use onebot_get_content instead/,
	);
});

test("send writes fire-and-forget frames", async (t) => {
	const server = new FakeOneBotServer();
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", log: silentLog });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});
	await waitFor(() => bot.connected);

	// Fire-and-forget usage: the frame is written immediately; the promise
	// still settles once the implementation answers (or the socket drops).
	const framePromise = server.nextFrame();
	const sendPromise = bot.send("send_private_msg", {
		user_id: 123,
		message: [{ type: "text", data: { text: "hi" } }],
	});
	const frame = await framePromise;
	assert.equal(frame.action, "send_private_msg");
	assert.equal(frame.params.user_id, 123);
	assert.equal(frame.params.message[0].data.text, "hi");
	server.reply(frame, { message_id: 9 });
	await sendPromise;
});

test("connect throws after bounded attempts when the server is unreachable", async () => {
	await assert.rejects(
		connect({
			baseUrl: "ws://127.0.0.1:1",
			accessToken: "",
			log: silentLog,
			reconnection: { enable: true, attempts: 3, delay: 20 },
		}),
		/could not connect/,
	);
});
