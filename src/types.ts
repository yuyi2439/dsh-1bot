// Shared plugin types: configuration, the structural service slice the bridge
// consumes, and the `ctx.onebot` service surface.
import type { AgentHandle, CreateAgentOptions, ModelSelection } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { OneBotClient } from "./client.ts";
import type { ChatRoute } from "./protocol.ts";

/** Plugin configuration (mirrors the schemastery `Config` in index.ts). */
export interface OnebotConfig {
	enabled: boolean;
	mode: string;
	ws_url: string;
	access_token: string;
	prefix: string;
	friend_ids: number[];
	group_ids: number[];
	/** Root for per-chat workspaces (default: `$DSH_HOME/workspaces/onebot`). */
	workspace_root?: string;
	/** Startup connect retries after the first attempt (default: 5). */
	connect_retries: number;
	/** Delay between startup connect attempts in seconds (default: 1). */
	connect_retry_delay_secs: number;
	reply_chunk_size: number;
	approval_timeout_secs: number;
	console_log: boolean;
}

/** Structural slice of the dsh services the bridge consumes. */
export interface BridgeServices {
	agents: { create(options: CreateAgentOptions): Promise<AgentHandle> };
	sessions: { flush(session: Session): Promise<boolean> };
	agentDefaultModel?: { currentSelection(): ModelSelection };
}

/** The `ctx.onebot` service surface exposed for other plugins (e.g. a persona-layer plugin). */
export interface OnebotService {
	client: OneBotClient;
	isAllowedTarget(target: string): boolean;
	send(target: string, text: string): void;
	sendReply(route: ChatRoute, text: string): void;
}
