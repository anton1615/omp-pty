import { PTYManager } from "../plugin/pty/manager";
import type { PTYSessionInfo } from "../plugin/pty/types";
import { DEFAULT_READ_LIMIT, formatList, formatReadResult, formatSearchResult, formatSpawned } from "../plugin/pty/formatters";
import { extractCommands, formatWritePreview, parseCommand, parseEscapeSequences } from "../plugin/pty/input";
import { checkCommandPermission, checkWorkdirPermission, resolvePermissionConfigFromEnv, type PTYPermissionConfig } from "../plugin/pty/permissions";
import { compilePattern } from "../plugin/pty/regex";

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

type SessionManagerContext = {
	getSessionId(): string;
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
	sessionManager?: SessionManagerContext;
};

type OmpPtyExtensionOptions = {
	permissions?: PTYPermissionConfig;
};

const EXTENSION_ID = "omp-pty";



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

function currentSessionId(ctx: ExtensionContext | undefined): string {
	return ctx?.sessionManager?.getSessionId() || "default";
}

function sessionBelongsTo(info: PTYSessionInfo, sessionId: string): boolean {
	return info.parentSessionId === undefined || info.parentSessionId === sessionId;
}

function currentSessionSessions(manager: PTYManager, ctx: ExtensionContext | undefined, includeAll = false): PTYSessionInfo[] {
	const sessions = manager.list();
	if (includeAll) return sessions;
	const sessionId = currentSessionId(ctx);
	return sessions.filter(session => sessionBelongsTo(session, sessionId));
}

function getCurrentSession(manager: PTYManager, id: string, ctx: ExtensionContext | undefined): PTYSessionInfo | null {
	const session = manager.get(id);
	if (!session || !sessionBelongsTo(session, currentSessionId(ctx))) return null;
	return session;
}

function currentSessionNotFound(id: string): string {
	return `PTY session not found in current OMP session: ${id}`;
}

export function createOmpPtyExtension(manager = new PTYManager(), options: OmpPtyExtensionOptions = {}): (pi: ExtensionAPI) => void {
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
		const permissionConfig = options.permissions ?? resolvePermissionConfigFromEnv();
		let switchingFromSessionId: string | undefined;

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
				const args = asStringArray(params.args) ?? [];
				const workdir = asString(params.workdir) ?? ctx?.cwd ?? process.cwd();
				try {
					checkCommandPermission(permissionConfig, command, args);
					checkWorkdirPermission(permissionConfig, workdir, ctx?.cwd ?? process.cwd());
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), { command, args, workdir }, true);
				}

				const info = runtimeManager.spawn({
					command,
					args,
					workdir,
					env: asStringRecord(params.env),
					title: asString(params.title),
					description: asString(params.description),
					parentSessionId: currentSessionId(ctx),
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
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const id = asString(params.id);
				const data = asString(params.data);
				if (!id || data === undefined) return textResult("pty_write requires id and data.", {}, true);
				const session = getCurrentSession(runtimeManager, id, ctx);
				if (!session) return textResult(currentSessionNotFound(id), { id }, true);
				if (session.status !== "running") {
					return textResult(`Cannot write to PTY '${id}' - session status is '${session.status}'.`, { id, status: session.status }, true);
				}
				const parsedData = parseEscapeSequences(data);
				try {
					for (const commandLine of extractCommands(parsedData)) {
						const parsedCommand = parseCommand(commandLine);
						if (parsedCommand.command) checkCommandPermission(permissionConfig, parsedCommand.command, parsedCommand.args);
					}
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), { id }, true);
				}
				const ok = runtimeManager.write(id, parsedData);
				const preview = formatWritePreview(parsedData);
				return textResult(
					ok ? `Sent ${parsedData.length} characters to ${id}: "${preview}"` : `Failed to write to PTY '${id}'.`,
					{ id, ok },
					!ok,
				);
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
				pattern: Type.Optional(Type.String({ description: "Optional regex filter. Matching is case-sensitive unless ignoreCase=true" })),
				ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive pattern matching; defaults to false" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const id = asString(params.id);
				if (!id) return textResult("pty_read requires id.", {}, true);
				const offset = asNumber(params.offset) ?? 0;
				const limit = asNumber(params.limit) ?? DEFAULT_READ_LIMIT;
				const pattern = asString(params.pattern);
				const ignoreCase = asBoolean(params.ignoreCase) ?? false;
				const session = getCurrentSession(runtimeManager, id, ctx);
				if (!session) return textResult(currentSessionNotFound(id), { id }, true);

				try {
					if (pattern) {
						const result = runtimeManager.search(id, compilePattern(pattern, ignoreCase), offset, limit);
						if (!result) return textResult(`PTY session not found: ${id}`, { id }, true);
						return textResult(formatSearchResult(id, pattern, session, result), { id, ...result });
					}

					const result = runtimeManager.read(id, offset, limit);
					if (!result) return textResult(`PTY session not found: ${id}`, { id }, true);
					return textResult(formatReadResult(id, session, result), { id, ...result });
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), { id }, true);
				}
			},
		});

		pi.registerTool({
			name: "pty_list",
			label: "PTY List",
			description: "List all PTY sessions with status, PID, command, and buffered line count.",
			parameters: Type.Object({
				all: Type.Optional(Type.Boolean({ description: "Include PTY sessions from every OMP session in this process" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const sessions = currentSessionSessions(runtimeManager, ctx, asBoolean(params.all) ?? false);
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
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const id = asString(params.id);
				if (!id) return textResult("pty_kill requires id.", {}, true);
				const cleanup = asBoolean(params.cleanup) ?? false;
				const session = getCurrentSession(runtimeManager, id, ctx);
				if (!session) return textResult(currentSessionNotFound(id), { id }, true);
				const ok = runtimeManager.kill(id, cleanup);
				return textResult(ok ? `Killed PTY session ${id}.` : `PTY session not found: ${id}`, { id, cleanup, ok }, !ok);
			},
		});

		pi.registerCommand("pty-list", {
			description: "List active PTY sessions",
			handler: async (_args, ctx) => {
				pi.sendMessage({ customType: EXTENSION_ID, content: formatList(currentSessionSessions(runtimeManager, ctx)), display: true });
				if (ctx.hasUI) ctx.ui.notify("PTY sessions listed.", "info");
			},
		});

		pi.registerCommand("pty-kill-all", {
			description: "Kill and clean up all PTY sessions",
			handler: async (_args, ctx) => {
				runtimeManager.cleanupBySession(currentSessionId(ctx));
				pi.sendMessage({ customType: EXTENSION_ID, content: "Current OMP session PTY sessions killed.", display: true });
				if (ctx.hasUI) ctx.ui.notify("Current OMP session PTY sessions killed.", "info");
			},
		});


		pi.on("session_before_switch", (_event, ctx) => {
			switchingFromSessionId = currentSessionId(ctx);
		});

		pi.on("session_switch", () => {
			if (!switchingFromSessionId) return;
			runtimeManager.cleanupBySession(switchingFromSessionId);
			switchingFromSessionId = undefined;
		});
		pi.on("session_shutdown", () => {
			runtimeManager.clearAllSessions();
		});
	};
}

export const createOpenCodePtyExtension = createOmpPtyExtension;
export default function ompPtyExtension(pi: ExtensionAPI): void {
	return createOmpPtyExtension(new PTYManager())(pi);
}
