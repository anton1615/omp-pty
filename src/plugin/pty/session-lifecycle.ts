import { RingBuffer } from "./buffer";
import { spawnWithBunPty } from "./process-spawner";
import type { PTYIdGenerator, PTYProcessSpawner, PTYSession, PTYSessionInfo, SpawnOptions } from "./types";

const SESSION_ID_BYTE_LENGTH = 4;
const DEFAULT_MAX_BUFFER_SIZE = Number.parseInt(process.env.PTY_MAX_BUFFER_SIZE || "1000000", 10);

function generateId(): string {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTE_LENGTH)))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
	return `pty_${hex}`;
}

function defaultTitle(command: string, args: string[], id: string): string {
	return `${command} ${args.join(" ")}`.trim() || `Terminal ${id.slice(-4)}`;
}

function normalizeSignal(signalCode: string | number | null): string | number | undefined {
	return signalCode === null || signalCode === "" ? undefined : signalCode;
}

export interface SessionLifecycleManagerOptions {
	spawner?: PTYProcessSpawner;
	idGenerator?: PTYIdGenerator;
	maxBufferSize?: number;
}

export class SessionLifecycleManager {
	readonly #sessions = new Map<string, PTYSession>();
	readonly #sessionTimeouts = new Map<string, NodeJS.Timeout>();
	readonly #spawner: PTYProcessSpawner;
	readonly #idGenerator: PTYIdGenerator;
	readonly #maxBufferSize: number;

	constructor(options: SessionLifecycleManagerOptions = {}) {
		this.#spawner = options.spawner ?? spawnWithBunPty;
		this.#idGenerator = options.idGenerator ?? generateId;
		this.#maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
	}

	#normalizeTimeoutSeconds(timeoutSeconds: number | undefined): number | undefined {
		if (timeoutSeconds === undefined) return undefined;
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error("timeoutSeconds must be a positive number in seconds");
		}
		return timeoutSeconds;
	}

	#clearSessionTimeout(id: string): void {
		const timeoutHandle = this.#sessionTimeouts.get(id);
		if (!timeoutHandle) return;
		clearTimeout(timeoutHandle);
		this.#sessionTimeouts.delete(id);
	}

	#scheduleSessionTimeout(session: PTYSession): void {
		if (session.timeoutSeconds === undefined) return;

		const timeoutHandle = setTimeout(() => {
			this.#sessionTimeouts.delete(session.id);
			const currentSession = this.#sessions.get(session.id);
			if (!currentSession || currentSession.status !== "running") return;

			currentSession.timedOut = true;
			this.kill(currentSession.id, false, "SIGTERM");
		}, session.timeoutSeconds * 1000);

		this.#sessionTimeouts.set(session.id, timeoutHandle);
	}

	#createSessionObject(opts: SpawnOptions): PTYSession {
		const id = this.#idGenerator();
		const args = opts.args ?? [];
		const workdir = opts.workdir ?? process.cwd();
		const timeoutSeconds = this.#normalizeTimeoutSeconds(opts.timeoutSeconds);

		return {
			id,
			title: opts.title ?? defaultTitle(opts.command, args, id),
			description: opts.description,
			command: opts.command,
			args,
			workdir,
			env: opts.env,
			status: "running",
			pid: 0,
			createdAt: new Date(),
			parentSessionId: opts.parentSessionId,
			parentAgent: opts.parentAgent,
			notifyOnExit: opts.notifyOnExit ?? false,
			timeoutSeconds,
			timedOut: false,
			buffer: new RingBuffer(this.#maxBufferSize),
			process: null,
		};
	}

	#spawnProcess(
		session: PTYSession,
		onData: (session: PTYSession, data: string) => void,
		onExit: (session: PTYSession, exitCode: number | null) => void,
	): void {
		const process = this.#spawner({
			command: session.command,
			args: session.args,
			workdir: session.workdir,
			env: session.env,
			onData: data => {
				session.buffer.append(data);
				onData(session, data);
			},
			onExit: (exitCode, signalCode) => {
				this.#clearSessionTimeout(session.id);
				session.buffer.flush();
				session.exitCode = exitCode ?? undefined;
				session.exitSignal = normalizeSignal(signalCode);
				if (session.status === "killing") {
					session.status = "killed";
				} else {
					session.status = "exited";
				}
				session.process?.close();
				onExit(session, exitCode);
			},
		});
		session.process = process;
		session.pid = process.pid;
	}

	spawn(
		opts: SpawnOptions,
		onData: (session: PTYSession, data: string) => void,
		onExit: (session: PTYSession, exitCode: number | null) => void,
	): PTYSessionInfo {
		const session = this.#createSessionObject(opts);
		this.#spawnProcess(session, onData, onExit);
		this.#sessions.set(session.id, session);
		this.#scheduleSessionTimeout(session);
		return this.toInfo(session);
	}

	kill(id: string, cleanup = false, signal = "SIGTERM"): boolean {
		const session = this.#sessions.get(id);
		if (!session) return false;

		this.#clearSessionTimeout(id);

		if (session.status === "running") {
			session.status = "killing";
			try {
				session.process?.kill(signal);
			} catch {
				// Ignore kill errors.
			}
		}

		if (cleanup) {
			session.buffer.clear();
			session.process?.close();
			this.#sessions.delete(id);
		}

		return true;
	}

	clearAllSessions(): void {
		for (const id of Array.from(this.#sessions.keys())) {
			this.kill(id, true);
		}
	}

	cleanupBySession(parentSessionId: string): void {
		for (const [id, session] of this.#sessions) {
			if (session.parentSessionId === parentSessionId) {
				this.kill(id, true);
			}
		}
	}

	getSession(id: string): PTYSession | null {
		return this.#sessions.get(id) ?? null;
	}

	listSessions(): PTYSession[] {
		return Array.from(this.#sessions.values());
	}

	toInfo(session: PTYSession): PTYSessionInfo {
		return {
			id: session.id,
			title: session.title,
			description: session.description,
			command: session.command,
			args: [...session.args],
			workdir: session.workdir,
			status: session.status,
			notifyOnExit: session.notifyOnExit,
			timeoutSeconds: session.timeoutSeconds,
			timedOut: session.timedOut,
			exitCode: session.exitCode,
			exitSignal: session.exitSignal,
			pid: session.pid,
			createdAt: session.createdAt.toISOString(),
			lineCount: session.buffer.length,
		};
	}
}
