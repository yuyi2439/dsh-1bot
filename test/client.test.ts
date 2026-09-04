// Client round-trip tests against a local `ws` server (ported from the
// nota-onebot ws_roundtrip test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { OneBotClient, type OneBotLog } from "../src/client.ts";
import { sendPrivateMsg } from "../src/protocol.ts";

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

/**
 * Stop the client, force-close every server-side socket, then close the
 * server — so the test process actually exits.
 */
async function teardown(client: OneBotClient, server: WebSocketServer): Promise<void> {
	client.stop();
	for (const ws of server.clients) ws.terminate();
	await new Promise((resolve) => server.close(resolve));
}

/** Parse a message body for assertions (string or segments). */
function toTextSafe(message: unknown): string {
	if (typeof message === "string") return message;
	return (message as Array<{ type?: string; data?: { text?: string } }>)
		.map((seg) => seg.data?.text ?? `[${seg.type}]`)
		.join("");
}

test("ws roundtrip: events forwarded, actions correlated by echo", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `ws://127.0.0.1:${address.port}`;

	// Register the connection promise BEFORE starting the client, but await
	// it only after `client.start()` — awaiting it up front would deadlock
	// (no client exists yet to initiate the connection).
	let serverSocket: WebSocket | undefined;
	const gotConnection = new Promise<WebSocket>((resolve) => {
		server.once("connection", (ws) => {
			serverSocket = ws;
			resolve(ws);
		});
	});

	const client = new OneBotClient({ wsUrl: url, accessToken: "", log: silentLog });
	t.after(() => teardown(client, server));
	const receivedEvents: Array<Record<string, unknown>> = [];
	client.onMessage((event) => receivedEvents.push(event));
	await client.start();
	await gotConnection;
	await waitFor(() => client.isConnected());

	// Server sends a private message event; the client must forward it.
	serverSocket!.send(JSON.stringify({
		post_type: "message",
		message_type: "private",
		message_id: 1,
		user_id: 42,
		self_id: 7,
		time: 1700000000,
		message: "ping",
		sender: { user_id: 42, nickname: "T" },
	}));
	await waitFor(() => receivedEvents.length === 1);
	assert.equal(receivedEvents[0].message_type, "private");
	assert.equal(toTextSafe(receivedEvents[0].message), "ping");

	// Client sends a correlated action; the server verifies and answers.
	const actionPromise = new Promise<Record<string, any>>((resolve) =>
		serverSocket!.once("message", (data) => resolve(JSON.parse(String(data)))),
	);
	const callPromise = client.call(sendPrivateMsg(42, "pong"));
	const action = await actionPromise;
	assert.equal(action.action, "send_private_msg");
	assert.equal(action.params.user_id, 42);
	assert.equal(action.params.message[0].data.text, "pong");
	serverSocket!.send(JSON.stringify({
		status: "ok",
		retcode: 0,
		echo: action.echo,
		data: { message_id: 9 },
	}));
	const resp = await callPromise;
	assert.equal(resp.status, "ok");
	assert.equal(resp.retcode, 0);
	assert.equal(resp.echo, action.echo);
});

test("sendAction writes fire-and-forget frames", async (t) => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `ws://127.0.0.1:${address.port}`;

	let serverSocket: WebSocket | undefined;
	const gotConnection = new Promise<WebSocket>((resolve) => {
		server.once("connection", (ws) => {
			serverSocket = ws;
			resolve(ws);
		});
	});

	const client = new OneBotClient({ wsUrl: url, accessToken: "", log: silentLog });
	t.after(() => teardown(client, server));
	await client.start();
	await gotConnection;
	await waitFor(() => client.isConnected());

	const frame = new Promise<Record<string, any>>((resolve) =>
		serverSocket!.once("message", (data) => resolve(JSON.parse(String(data)))),
	);
	assert.equal(client.sendAction(sendPrivateMsg(123, "hi")), true);
	const action = await frame;
	assert.equal(action.action, "send_private_msg");
	assert.equal(action.params.user_id, 123);
});

test("start rejects after retries when the server is unreachable", async () => {
	const client = new OneBotClient({ wsUrl: "ws://127.0.0.1:1", accessToken: "", log: silentLog });
	await assert.rejects(client.start({ retries: 2, retryDelayMs: 20 }), /could not connect/);
	client.stop();
});

test("call rejects immediately when disconnected", async () => {
	const client = new OneBotClient({ wsUrl: "ws://127.0.0.1:1", accessToken: "", log: silentLog });
	await assert.rejects(client.call(sendPrivateMsg(1, "x")), /not connected/);
	client.stop();
});
