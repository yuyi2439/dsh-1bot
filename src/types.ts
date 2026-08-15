// Shared plugin types: configuration, the structural service slice the bridge
// consumes, and the `ctx.onebot` service surface.
import type { AgentHandle, CreateAgentOptions, ModelSelection } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
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
	cwd?: string;
	reply_chunk_size: number;
	approval_timeout_secs: number;
	console_log: boolean;
}

/** Structural slice of the dsh services the bridge consumes. */
export interface BridgeServices {
	agents: { create(options: CreateAgentOptions): Promise<AgentHandle> };
	sessions: { flush(session: Session): Promise<boolean> };
	agentDefaultModel?: { currentSelection(): ModelSelection };
	approval?: { request(req: ApprovalRequest): Promise<ApprovalOutcome> };
}

/** The `ctx.onebot` service surface exposed for other plugins (e.g. dsh-nota). */
export interface OnebotService {
	client: OneBotClient;
	isAllowedTarget(target: string): boolean;
	send(target: string, text: string): void;
	sendApproved(target: string, text: string): void;
	sendReply(route: ChatRoute, text: string): void;
}
