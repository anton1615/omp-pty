import { spawn as spawnPty, type IPty } from "bun-pty";
import type { ManagedPTYProcess, PTYProcessSpawnerOptions } from "./types";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

function normalizeSignal(signalCode: string | number | null): string | number | undefined {
	return signalCode === null || signalCode === "" ? undefined : signalCode;
}

export function spawnWithBunPty(options: PTYProcessSpawnerOptions): ManagedPTYProcess {
	const env = { ...process.env, ...options.env } as Record<string, string>;
	const processHandle: IPty = spawnPty(options.command, options.args, {
		name: "xterm-256color",
		cols: DEFAULT_TERMINAL_COLS,
		rows: DEFAULT_TERMINAL_ROWS,
		cwd: options.workdir,
		env,
	});
	const dataSubscription = processHandle.onData((data: string) => {
		options.onData(data);
	});
	const exitSubscription = processHandle.onExit(({ exitCode, signal }) => {
		options.onExit(exitCode ?? null, normalizeSignal(signal ?? null) ?? null);
	});

	return {
		pid: processHandle.pid,
		write(data: string): void {
			processHandle.write(data);
		},
		kill(signal?: string): void {
			processHandle.kill(signal);
		},
		close(): void {
			dataSubscription.dispose();
			exitSubscription.dispose();
		},
	};
}
