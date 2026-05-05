import { NotificationManager } from "./notification-manager";
import { OutputManager } from "./output-manager";
import { SessionLifecycleManager } from "./session-lifecycle";
import type { PTYExitNotifier, PTYManagerOptions, PTYSessionInfo, ReadResult, SearchResult, SpawnOptions } from "./types";
import { withSession } from "./utils";

type SessionUpdateCallback = (session: PTYSessionInfo) => void;

export const sessionUpdateCallbacks: SessionUpdateCallback[] = [];

export function registerSessionUpdateCallback(callback: SessionUpdateCallback): void {
	sessionUpdateCallbacks.push(callback);
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback): void {
	const index = sessionUpdateCallbacks.indexOf(callback);
	if (index !== -1) {
		sessionUpdateCallbacks.splice(index, 1);
	}
}

function notifySessionUpdate(session: PTYSessionInfo): void {
	for (const callback of sessionUpdateCallbacks) {
		try {
			callback(session);
		} catch {
			// Ignore callback errors.
		}
	}
}

type RawOutputCallback = (session: PTYSessionInfo, rawData: string) => void;

export const rawOutputCallbacks: RawOutputCallback[] = [];

export function registerRawOutputCallback(callback: RawOutputCallback): void {
	rawOutputCallbacks.push(callback);
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
	const index = rawOutputCallbacks.indexOf(callback);
	if (index !== -1) {
		rawOutputCallbacks.splice(index, 1);
	}
}

function notifyRawOutput(session: PTYSessionInfo, rawData: string): void {
	for (const callback of rawOutputCallbacks) {
		try {
			callback(session, rawData);
		} catch {
			// Ignore callback errors.
		}
	}
}

export class PTYManager {
	readonly #lifecycleManager: SessionLifecycleManager;
	readonly #outputManager = new OutputManager();
	readonly #notificationManager = new NotificationManager();

	constructor(options: PTYManagerOptions = {}) {
		this.#lifecycleManager = new SessionLifecycleManager({
			spawner: options.spawner,
			idGenerator: options.idGenerator,
			maxBufferSize: options.maxBufferSize,
		});
		this.#notificationManager.init(options.notify);
	}

	setNotifier(notify: PTYExitNotifier | undefined): void {
		this.#notificationManager.init(notify);
	}

	clearAllSessions(): void {
		this.#lifecycleManager.clearAllSessions();
	}

	spawn(opts: SpawnOptions): PTYSessionInfo {
		const session = this.#lifecycleManager.spawn(
			opts,
			(session, data) => {
				notifyRawOutput(this.#lifecycleManager.toInfo(session), data);
			},
			(session) => {
				const info = this.#lifecycleManager.toInfo(session);
				notifySessionUpdate(info);
				if (session.notifyOnExit) {
					this.#notificationManager.sendExitNotification(session);
				}
			},
		);
		notifySessionUpdate(session);
		return session;
	}

	write(id: string, data: string): boolean {
		return withSession(this.#lifecycleManager, id, session => this.#outputManager.write(session, data), false);
	}

	read(id: string, offset = 0, limit?: number): ReadResult | null {
		return withSession(this.#lifecycleManager, id, session => this.#outputManager.read(session, offset, limit), null);
	}

	search(id: string, pattern: RegExp, offset = 0, limit?: number): SearchResult | null {
		return withSession(this.#lifecycleManager, id, session => this.#outputManager.search(session, pattern, offset, limit), null);
	}

	list(): PTYSessionInfo[] {
		return this.#lifecycleManager.listSessions().map(session => this.#lifecycleManager.toInfo(session));
	}

	get(id: string): PTYSessionInfo | null {
		return withSession(this.#lifecycleManager, id, session => this.#lifecycleManager.toInfo(session), null);
	}

	getRawBuffer(id: string): { raw: string; byteLength: number } | null {
		return withSession(
			this.#lifecycleManager,
			id,
			session => ({ raw: session.buffer.readRaw(), byteLength: session.buffer.byteLength }),
			null,
		);
	}

	kill(id: string, cleanup = false): boolean {
		return this.#lifecycleManager.kill(id, cleanup);
	}

	cleanupBySession(parentSessionId: string): void {
		this.#lifecycleManager.cleanupBySession(parentSessionId);
	}
}

export const manager = new PTYManager();
