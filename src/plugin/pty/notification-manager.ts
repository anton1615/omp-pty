import type { PTYExitNotifier, PTYSession } from "./types";

const NOTIFICATION_LINE_TRUNCATE = 250;
const NOTIFICATION_TITLE_TRUNCATE = 64;

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function findLastNonEmptyLine(session: PTYSession): string {
	return truncate(session.buffer.getLastNonEmptyLine(), NOTIFICATION_LINE_TRUNCATE);
}

export function formatExitNotification(session: PTYSession): string {
	const exitCode = session.exitCode ?? "unknown";
	const lineCount = session.buffer.getLineCount();
	const displayTitle = truncate(session.description ?? session.title, NOTIFICATION_TITLE_TRUNCATE);
	const lines = [
		"<pty_exited>",
		`ID: ${session.id}`,
		`Description: ${displayTitle}`,
		`Exit Code: ${exitCode}`,
		`TimeoutSeconds: ${session.timeoutSeconds ?? "none"}`,
		`Timed Out: ${session.timedOut ? "yes" : "no"}`,
		`Output Lines: ${lineCount}`,
		`Last Line: ${findLastNonEmptyLine(session)}`,
		"</pty_exited>",
		"",
	];

	if (session.timedOut) {
		lines.push("Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output.");
	} else if (session.exitCode === 0) {
		lines.push("Use pty_read to check the full output.");
	} else {
		lines.push("Process failed. Use pty_read with the pattern parameter to search for errors in the output.");
	}

	return lines.join("\n");
}

export class NotificationManager {
	#notify: PTYExitNotifier | undefined;

	init(notify: PTYExitNotifier | undefined): void {
		this.#notify = notify;
	}

	sendExitNotification(session: PTYSession): void {
		this.#notify?.(formatExitNotification(session));
	}
}
