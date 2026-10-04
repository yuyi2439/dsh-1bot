// onebot.js 客户端（本插件的协议层）的集成测试：connect 工厂只在连接建立后
// resolve，事件会被转发，invoke 成功时给出 data、失败时格式化错误。测试跑在
// 本地 `ws` 服务器上，因此不需要真实的 OneBot 实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { connect, type OneBotClient, type OneBotLogger } from "onebot.js";

/** 客户端只写 info/warn/debug；测试里这些方法什么都不用做。 */
const silentLogger: OneBotLogger = {
	info() {},
	warn() {},
	debug() {},
};

/** 等到断言成立（每 10ms 轮询一次）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor: condition not met in time");
}

/** 一个假的 OneBot 实现：会应答带 echo 的动作，也能主动推送事件。 */
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

	/** 第一个连上来的客户端 socket（测试只用单个客户端）。 */
	get socket(): WebSocket {
		const ws = this.sockets.values().next().value;
		assert.ok(ws, "no client socket connected");
		return ws;
	}

	/** 用一条成功信封应答某个动作帧。 */
	reply(frame: Record<string, any>, data: unknown, overrides: Record<string, unknown> = {}): void {
		this.socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data, ...overrides }));
	}

	/** 向每个已连接客户端推送一个 OneBot 事件（不带 echo）。 */
	push(event: Record<string, unknown>): void {
		const body = JSON.stringify(event);
		for (const ws of this.sockets) ws.send(body);
	}

	/** 等待客户端发出的下一个动作帧。 */
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
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", logger: silentLogger });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});

	assert.equal(bot.connected, true);
	const receivedEvents: Array<Record<string, unknown>> = [];
	bot.on("message", (event) => receivedEvents.push(event as unknown as Record<string, unknown>));

	// 服务器推送一个私聊消息事件；客户端必须转发它。
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

	// 带类型的关联调用：帧里带 action/params/echo；data 会回来。
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
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", logger: silentLogger });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});
	await waitFor(() => bot.connected);

	const framePromise = server.nextFrame();
	const invokePromise = bot.invoke("get_login_info", {});
	const frame = await framePromise;
	// 完全没有 retcode —— 仅凭 status "ok" 就必须判定调用成功。
	server.socket.send(JSON.stringify({ echo: frame.echo, status: "ok", data: { user_id: 7, nickname: "Bot" } }));
	const data = await invokePromise;
	assert.deepEqual(data, { user_id: 7, nickname: "Bot" });
});

test("invoke formats failures with action, retcode, detail and the hint", async (t) => {
	const server = new FakeOneBotServer();
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", logger: silentLogger });
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
	const bot = await connect({ baseUrl: await server.url(), accessToken: "", logger: silentLogger });
	t.after(() => {
		bot.disconnect();
		return server.close();
	});
	await waitFor(() => bot.connected);

	// fire-and-forget 用法：帧会立刻写出；promise 仍会在实现端应答（或
	// socket 断开）后 settle。
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
			logger: silentLogger,
			reconnection: { enable: true, attempts: 3, delay: 20 },
		}),
		/could not connect/,
	);
});
