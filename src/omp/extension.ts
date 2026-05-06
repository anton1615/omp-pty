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

const EXTENSION_ID = "omp-pty";
const NOTIFY_ON_EXIT_INSTRUCTIONS = [
	"<system_reminder>",
	"Completion signal for this session is the future `<pty_exited>` message.",
	"If you only need to know whether the command finished, do not call `pty_read`; wait for `<pty_exited>`.",
	"Never use sleep plus `pty_read` loops to check completion for this session.",
	"Call `pty_read` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.",
	"</system_reminder>",
].join("\n");
const DEFAULT_READ_LIMIT = 500;
const MAX_LINE_LENGTH = 2000;
const ETX = String.fromCharCode(3);
const EOT = String.fromCharCode(4);


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

function formatLine(line: string, lineNumber: number, maxLength = MAX_LINE_LENGTH): string {
	const lineNumberText = lineNumber.toString().padStart(5, "0");
	const truncatedLine = line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
	return `${lineNumberText}| ${truncatedLine}`;
}

function buildTimeoutReminder(session: PTYSessionInfo): string {
	return [
		"<system_reminder>",
		`This session was auto-killed after reaching \`timeoutSeconds=${session.timeoutSeconds ?? "unknown"}\`.`,
		"Use `pty_read` to inspect the final output or `pty_list` to review other sessions.",
		"</system_reminder>",
	].join("\n");
}

function appendSessionReminders(output: string, session: PTYSessionInfo): string {
	let result = output;
	if (session.notifyOnExit && session.status === "running") {
		result = `${result}\n\n${NOTIFY_ON_EXIT_INSTRUCTIONS}`;
	}
	if (session.timedOut) {
		result = `${result}\n\n${buildTimeoutReminder(session)}`;
	}
	return result;
}

function formatPtyOutput(
	id: string,
	status: string,
	pattern: string | undefined,
	formattedLines: string[],
	hasMore: boolean,
	paginationMessage: string,
	endMessage: string,
): string {
	return [
		`<pty_output id="${id}" status="${status}"${pattern ? ` pattern="${pattern}"` : ""}>`,
		...formattedLines,
		"",
		hasMore ? paginationMessage : endMessage,
		"</pty_output>",
	].join("\n");
}

function formatReadResult(id: string, session: PTYSessionInfo, result: ReadResult): string {
	if (result.lines.length === 0) {
		return appendSessionReminders(
			[
				`<pty_output id="${id}" status="${session.status}">`,
				result.totalLines === 0
					? "(No output available - buffer is empty)"
					: `Offset ${result.offset} is beyond available output (${result.totalLines} total lines).`,
				`Total lines: ${result.totalLines}`,
				"</pty_output>",
			].join("\n"),
			session,
		);
	}

	const formattedLines = result.lines.map((line, index) => formatLine(line, result.offset + index + 1));
	const paginationMessage = `(Buffer has more lines. Use offset=${result.offset + result.lines.length} to read beyond line ${result.offset + result.lines.length})`;
	const endMessage = `(End of buffer - total ${result.totalLines} lines)`;
	return appendSessionReminders(
		formatPtyOutput(id, session.status, undefined, formattedLines, result.hasMore, paginationMessage, endMessage),
		session,
	);
}

function formatSearchResult(id: string, pattern: string, session: PTYSessionInfo, result: SearchResult): string {
	if (result.matches.length === 0) {
		return appendSessionReminders(
			[
				`<pty_output id="${id}" status="${session.status}" pattern="${pattern}">`,
				`No lines matched the pattern '${pattern}'.`,
				`Total lines in buffer: ${result.totalLines}`,
				"</pty_output>",
			].join("\n"),
			session,
		);
	}

	const formattedLines = result.matches.map(match => formatLine(match.text, match.lineNumber));
	const paginationMessage = `(${result.matches.length} of ${result.totalMatches} matches shown. Use offset=${result.offset + result.matches.length} to see more.)`;
	const endMessage = `(${result.totalMatches} match${result.totalMatches === 1 ? "" : "es"} from ${result.totalLines} total lines)`;
	return appendSessionReminders(
		formatPtyOutput(id, session.status, pattern, formattedLines, result.hasMore, paginationMessage, endMessage),
		session,
	);
}

function validateRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		const dangerousPatterns = [
			/\([^)]*[+*][^)]*\)[+*?{]/,
			/\([^)]*\{[^)]*\}[^)]*\)[+*?{]/,
			/\(\?:.*\)\*.*\(\?:.*\)\*/,
			/.*\(\.\*\?\)\{2,\}.*/,
			/.*\(.*\|.*\)\{3,\}.*/,
		];
		return !dangerousPatterns.some(dangerous => dangerous.test(pattern));
	} catch {
		return false;
	}
}

function compilePattern(pattern: string, ignoreCase?: boolean): RegExp {
	if (!validateRegex(pattern)) {
		throw new Error(`Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.`);
	}
	try {
		return new RegExp(pattern, ignoreCase ? "i" : "");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid regex pattern '${pattern}': ${message}`);
	}
}

function parseEscapeSequences(input: string): string {
	return input.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g, (match, seq: string) => {
		if (seq.startsWith("x")) return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
		if (seq.startsWith("u")) return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
		switch (seq) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "\\":
				return "\\";
			default:
				return match;
		}
	});
}

function formatWritePreview(data: string): string {
	const preview = data.length > 50 ? `${data.slice(0, 50)}...` : data;
	return preview
		.replace(new RegExp(ETX, "g"), "^C")
		.replace(new RegExp(EOT, "g"), "^D")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r");
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

				const info = runtimeManager.spawn({
					command,
					args: asStringArray(params.args) ?? [],
					workdir: asString(params.workdir) ?? ctx?.cwd ?? process.cwd(),
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
