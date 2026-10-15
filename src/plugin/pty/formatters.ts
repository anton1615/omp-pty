import type { PTYSessionInfo, ReadResult, SearchResult } from "./types";

export const DEFAULT_READ_LIMIT = 500;
export const MAX_LINE_LENGTH = 2000;

export const NOTIFY_ON_EXIT_INSTRUCTIONS = [
	"<system_reminder>",
	"Completion signal for this session is the future `<pty_exited>` message.",
	"If you only need to know whether the command finished, do not call `pty_read`; wait for `<pty_exited>`.",
	"Never use sleep plus `pty_read` loops to check completion for this session.",
	"Call `pty_read` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.",
	"</system_reminder>",
].join("\n");

export function formatCommand(info: Pick<PTYSessionInfo, "command" | "args">): string {
	return info.args.length > 0 ? `${info.command} ${info.args.join(" ")}` : info.command;
}

export function formatSessionSummary(info: PTYSessionInfo): string {
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
		`  ExitAt: ${info.exitAt ?? "none"}`,
	].join("\n");
}

export function formatList(sessions: PTYSessionInfo[]): string {
	if (sessions.length === 0) return "No PTY sessions.";
	return sessions.map(formatSessionSummary).join("\n\n");
}

export function formatSpawned(info: PTYSessionInfo): string {
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

export function formatLine(line: string, lineNumber: number, maxLength = MAX_LINE_LENGTH): string {
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

export function formatReadResult(id: string, session: PTYSessionInfo, result: ReadResult): string {
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

export function formatSearchResult(id: string, pattern: string, session: PTYSessionInfo, result: SearchResult): string {
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
