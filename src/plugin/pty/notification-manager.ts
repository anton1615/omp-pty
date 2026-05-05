import type { PTYExitNotifier, PTYSession } from "./types";

function formatCommand(command: string, args: string[]): string {
	return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

export function formatExitNotification(session: PTYSession): string {
	return [
		"<pty_exited>",
		`ID: ${session.id}`,
		`Title: ${session.title}`,
		`Command: ${formatCommand(session.command, session.args)}`,
		`Workdir: ${session.workdir}`,
		`ExitCode: ${session.exitCode ?? "unknown"}`,
		`Signal: ${session.exitSignal ?? "none"}`,
		`TimedOut: ${session.timedOut}`,
		"</pty_exited>",
	].join("\n");
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
