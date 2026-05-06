import { semver } from "bun";
import { spawn as spawnPty, Terminal, type IPty } from "bun-pty";
import { version as bunPtyVersion } from "bun-pty/package.json";
import type { ManagedPTYProcess, PTYProcessSpawnerOptions } from "./types";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

if (semver.order(bunPtyVersion, "0.4.8") > 0) {
	throw new Error(`bun-pty version ${bunPtyVersion} is too new for patching; remove the workaround.`);
}

const terminalPrototype = Terminal.prototype as unknown as {
	_startReadLoop?: (...args: unknown[]) => unknown;
	__ompReadLoopPatched?: boolean;
};
const originalStartReadLoop = terminalPrototype._startReadLoop;

if (!terminalPrototype.__ompReadLoopPatched && typeof originalStartReadLoop === "function") {
	terminalPrototype._startReadLoop = async function patchedStartReadLoop(this: InstanceType<typeof Terminal>, ...args: unknown[]) {
		await Promise.resolve();
		return originalStartReadLoop.apply(this, args);
	};
	terminalPrototype.__ompReadLoopPatched = true;
}

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
