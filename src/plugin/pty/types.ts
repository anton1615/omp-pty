import type { RingBuffer, SearchMatch } from "./buffer";

export type PTYStatus = "running" | "exited" | "killing" | "killed";

export interface ManagedPTYProcess {
	pid: number;
	write(data: string): void;
	kill(signal?: string): void;
	close(): void;
}

export interface PTYProcessSpawnerOptions {
	command: string;
	args: string[];
	workdir: string;
	env?: Record<string, string>;
	onData(data: string): void;
	onExit(exitCode: number | null, signalCode: string | number | null): void;
}

export type PTYProcessSpawner = (options: PTYProcessSpawnerOptions) => ManagedPTYProcess;
export type PTYExitNotifier = (message: string) => void;
export type PTYIdGenerator = () => string;

export interface PTYSession {
	id: string;
	title: string;
	description?: string;
	command: string;
	args: string[];
	workdir: string;
	env?: Record<string, string>;
	status: PTYStatus;
	exitCode?: number;
	exitSignal?: string | number;
	pid: number;
	createdAt: Date;
	parentSessionId?: string;
	parentAgent?: string;
	notifyOnExit: boolean;
	timeoutSeconds?: number;
	timedOut: boolean;
	buffer: RingBuffer;
	process: ManagedPTYProcess | null;
}

export interface PTYSessionInfo {
	id: string;
	title: string;
	description?: string;
	command: string;
	args: string[];
	workdir: string;
	status: PTYStatus;
	notifyOnExit: boolean;
	timeoutSeconds?: number;
	timedOut: boolean;
	exitCode?: number;
	exitSignal?: string | number;
	pid: number;
	createdAt: string;
	lineCount: number;
}

export interface SpawnOptions {
	command: string;
	args?: string[];
	workdir?: string;
	env?: Record<string, string>;
	title?: string;
	description?: string;
	parentSessionId?: string;
	parentAgent?: string;
	notifyOnExit?: boolean;
	timeoutSeconds?: number;
}

export interface ReadResult {
	lines: string[];
	totalLines: number;
	offset: number;
	hasMore: boolean;
}

export interface SearchResult {
	matches: SearchMatch[];
	totalMatches: number;
	totalLines: number;
	offset: number;
	hasMore: boolean;
}

export interface PTYManagerOptions {
	spawner?: PTYProcessSpawner;
	notify?: PTYExitNotifier;
	idGenerator?: PTYIdGenerator;
	maxBufferSize?: number;
}
