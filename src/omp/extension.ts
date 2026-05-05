import { PTYManager } from "../plugin/pty/manager";
import type { PTYSessionInfo, ReadResult, SearchResult } from "../plugin/pty/types";

type ToolContent = { type: "text"; text: string };
type ToolResult<TDetails = unknown> = { content: ToolContent[]; details: TDetails; isError?: boolean };
type ToolExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) => Promise<ToolResult> | ToolResult;

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: ToolExecute;
};

type CommandContext = ExtensionContext & {
	waitForIdle?: () => Promise<void>;
};

type TypeFactory = {
	Object(properties: Record<string, unknown>): unknown;
	String(options?: Record<string, unknown>): unknown;
	Number(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Array(item: unknown, options?: Record<string, unknown>): unknown;
	Record(key: unknown, value: unknown, options?: Record<string, unknown>): unknown;
	Optional(schema: unknown): unknown;
};

type ExtensionAPI = {
	typebox: { Type: TypeFactory } | TypeFactory;
	registerTool(tool: ToolDefinition): void;
	registerCommand(
		name: string,
		options: { description?: string; handler(args: string, ctx: CommandContext): Promise<void> | void },
	): void;
	on(eventName: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	sendMessage<T = unknown>(
		message: { customType: string; content: string; display?: boolean; details?: T; attribution?: "user" | "agent" },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	logger?: { debug(message: string, details?: Record<string, unknown>): void };
};

type ExtensionContext = {
	cwd: string;
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
};

const EXTENSION_ID = "omp-pty";
const NOTIFY_ON_EXIT_INSTRUCTIONS = [
	"<system_reminder>",
	"Completion signal for this session is the future `<pty_exited>` message.",
	"If you only need to know whether the command finished, do not call `pty_read`; wait for `<pty_exited>`.",
	"Never use sleep plus `pty_read` loops to check completion for this session.",
	"Call `pty_read` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.",
	"</system_reminder>",
].join("\n");

function resolveTypeFactory(pi: ExtensionAPI): TypeFactory {
	const maybeNested = pi.typebox as { Type?: TypeFactory };
	return maybeNested.Type ?? (pi.typebox as TypeFactory);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined;
	return Object.fromEntries(entries);
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textResult<TDetails>(text: string, details: TDetails, isError = false): ToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function formatCommand(info: Pick<PTYSessionInfo, "command" | "args">): string {
	return info.args.length > 0 ? `${info.command} ${info.args.join(" ")}` : info.command;
}

function formatSessionSummary(info: PTYSessionInfo): string {
	return [
		`${info.id} · ${info.status} · ${info.title}`,
		`  Command: ${formatCommand(info)}`,
		`  Workdir: ${info.workdir}`,
		`  PID: ${info.pid}`,
		`  Lines: ${info.lineCount}`,
		`  NotifyOnExit: ${info.notifyOnExit}`,
		`  TimeoutSeconds: ${info.timeoutSeconds ?? "none"}`,
		`  TimedOut: ${info.timedOut}`,
		`  ExitCode: ${info.exitCode ?? "none"}`,
		`  Signal: ${info.exitSignal ?? "none"}`,
	].join("\n");
}

function formatList(sessions: PTYSessionInfo[]): string {
	if (sessions.length === 0) return "No PTY sessions.";
	return sessions.map(formatSessionSummary).join("\n\n");
}

function formatSpawned(info: PTYSessionInfo): string {
	return [
		"<pty_spawned>",
		`ID: ${info.id}`,
		`Title: ${info.title}`,
		`Command: ${formatCommand(info)}`,
		`Workdir: ${info.workdir}`,
		`PID: ${info.pid}`,
		`Status: ${info.status}`,
		`NotifyOnExit: ${info.notifyOnExit}`,
		`TimeoutSeconds: ${info.timeoutSeconds ?? "none"}`,
		"</pty_spawned>",
		...(info.notifyOnExit ? ["", NOTIFY_ON_EXIT_INSTRUCTIONS] : []),
	].join("\n");
}

function formatReadResult(result: ReadResult): string {
	return [
		"<pty_output>",
		`Offset: ${result.offset}`,
		`TotalLines: ${result.totalLines}`,
		`HasMore: ${result.hasMore}`,
		"---",
		...result.lines,
		"</pty_output>",
	].join("\n");
}

function formatSearchResult(result: SearchResult): string {
	return [
		"<pty_matches>",
		`Offset: ${result.offset}`,
		`TotalMatches: ${result.totalMatches}`,
		`TotalLines: ${result.totalLines}`,
		`HasMore: ${result.hasMore}`,
		"---",
		...result.matches.map(match => `${match.lineNumber}: ${match.text}`),
		"</pty_matches>",
	].join("\n");
}

function compilePattern(pattern: string): RegExp {
	return new RegExp(pattern, "i");
}

export function createOmpPtyExtension(manager = new PTYManager()): (pi: ExtensionAPI) => void {
	return function ompPtyExtension(pi: ExtensionAPI): void {
		const Type = resolveTypeFactory(pi);

		const notify = (message: string): void => {
			pi.sendMessage(
				{ customType: EXTENSION_ID, content: message, display: true, attribution: "agent" },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
		};

		const runtimeManager = manager;
		runtimeManager.setNotifier(notify);

		pi.registerTool({
			name: "pty_spawn",
			label: "PTY Spawn",
			description:
				"Start a long-running or interactive command in a persistent PTY session. Prefer regular bash for short non-interactive commands.",
			parameters: Type.Object({
				command: Type.String({ description: "Executable to run without a shell wrapper" }),
				args: Type.Optional(Type.Array(Type.String(), { description: "Arguments to pass to the executable" })),
				workdir: Type.Optional(Type.String({ description: "Working directory; defaults to current OMP cwd" })),
				env: Type.Optional(
					Type.Record(Type.String(), Type.String(), { description: "Additional environment variables" }),
				),
				title: Type.Optional(Type.String({ description: "Human-readable title for this PTY session" })),
				description: Type.Optional(Type.String({ description: "Concise purpose of this PTY session" })),
				notifyOnExit: Type.Optional(
					Type.Boolean({ description: "If true, queues a <pty_exited> message when the process exits" }),
				),
				timeoutSeconds: Type.Optional(
					Type.Number({ description: "Optional timeout in seconds before the PTY is terminated" }),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const command = asString(params.command);
				if (!command) return textResult("pty_spawn requires a non-empty command.", {}, true);

				const info = runtimeManager.spawn({
					command,
					args: asStringArray(params.args) ?? [],
					workdir: asString(params.workdir) ?? ctx.cwd,
					env: asStringRecord(params.env),
					title: asString(params.title),
					description: asString(params.description),
					notifyOnExit: asBoolean(params.notifyOnExit),
					timeoutSeconds: asNumber(params.timeoutSeconds),
				});

				return textResult(formatSpawned(info), info);
			},
		});

		pi.registerTool({
			name: "pty_write",
			label: "PTY Write",
			description: "Send input to a running PTY session. Use escape sequences such as \\x03 for Ctrl+C.",
			parameters: Type.Object({
				id: Type.String({ description: "PTY session ID" }),
				data: Type.String({ description: "Text or escape sequence to write" }),
			}),
			execute: async (_toolCallId, params) => {
				const id = asString(params.id);
				const data = asString(params.data);
				if (!id || data === undefined) return textResult("pty_write requires id and data.", {}, true);
				const ok = runtimeManager.write(id, data);
				return textResult(ok ? `Wrote ${data.length} characters to ${id}.` : `PTY session not running: ${id}`, { id, ok }, !ok);
			},
		});

		pi.registerTool({
			name: "pty_read",
			label: "PTY Read",
			description: "Read buffered PTY output with pagination, or filter output with a regex pattern.",
			parameters: Type.Object({
				id: Type.String({ description: "PTY session ID" }),
				offset: Type.Optional(Type.Number({ description: "Zero-based line or match offset" })),
				limit: Type.Optional(Type.Number({ description: "Maximum number of lines or matches to return" })),
				pattern: Type.Optional(Type.String({ description: "Optional case-insensitive regex filter" })),
			}),
			execute: async (_toolCallId, params) => {
				const id = asString(params.id);
				if (!id) return textResult("pty_read requires id.", {}, true);
				const offset = asNumber(params.offset) ?? 0;
				const limit = asNumber(params.limit);
				const pattern = asString(params.pattern);

				try {
					if (pattern) {
						const result = runtimeManager.search(id, compilePattern(pattern), offset, limit);
						if (!result) return textResult(`PTY session not found: ${id}`, { id }, true);
						return textResult(formatSearchResult(result), { id, ...result });
					}

					const result = runtimeManager.read(id, offset, limit);
					if (!result) return textResult(`PTY session not found: ${id}`, { id }, true);
					return textResult(formatReadResult(result), { id, ...result });
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), { id }, true);
				}
			},
		});

		pi.registerTool({
			name: "pty_list",
			label: "PTY List",
			description: "List all PTY sessions with status, PID, command, and buffered line count.",
			parameters: Type.Object({}),
			execute: async () => {
				const sessions = runtimeManager.list();
				return textResult(formatList(sessions), { sessions });
			},
		});

		pi.registerTool({
			name: "pty_kill",
			label: "PTY Kill",
			description: "Terminate a PTY session. Set cleanup=true to remove it from pty_list after killing.",
			parameters: Type.Object({
				id: Type.String({ description: "PTY session ID" }),
				cleanup: Type.Optional(Type.Boolean({ description: "Remove session metadata and buffer after killing" })),
			}),
			execute: async (_toolCallId, params) => {
				const id = asString(params.id);
				if (!id) return textResult("pty_kill requires id.", {}, true);
				const cleanup = asBoolean(params.cleanup) ?? false;
				const ok = runtimeManager.kill(id, cleanup);
				return textResult(ok ? `Killed PTY session ${id}.` : `PTY session not found: ${id}`, { id, cleanup, ok }, !ok);
			},
		});

		pi.registerCommand("pty-list", {
			description: "List active PTY sessions",
			handler: async (_args, ctx) => {
				pi.sendMessage({ customType: EXTENSION_ID, content: formatList(runtimeManager.list()), display: true });
				if (ctx.hasUI) ctx.ui.notify("PTY sessions listed.", "info");
			},
		});

		pi.registerCommand("pty-kill-all", {
			description: "Kill and clean up all PTY sessions",
			handler: async (_args, ctx) => {
				runtimeManager.clearAllSessions();
				pi.sendMessage({ customType: EXTENSION_ID, content: "All PTY sessions killed.", display: true });
				if (ctx.hasUI) ctx.ui.notify("All PTY sessions killed.", "info");
			},
		});

		pi.on("session_shutdown", () => {
			runtimeManager.clearAllSessions();
		});
	};
}

export const createOpenCodePtyExtension = createOmpPtyExtension;
export default createOmpPtyExtension();
