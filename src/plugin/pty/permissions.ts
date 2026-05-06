import path from "node:path";
import { allStructured } from "./wildcard";

export type PermissionAction = "allow" | "ask" | "deny";
export type BashPermissions = PermissionAction | Record<string, PermissionAction>;

export interface PTYPermissionConfig {
	bash?: BashPermissions;
	external_directory?: PermissionAction;
}

function normalizePermissionAction(value: string | undefined): PermissionAction | undefined {
	if (value === "allow" || value === "ask" || value === "deny") return value;
	return undefined;
}

function parseBashPermissions(value: string | undefined): BashPermissions | undefined {
	if (!value) return undefined;
	const direct = normalizePermissionAction(value);
	if (direct) return direct;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const entries = Object.entries(parsed);
		if (!entries.every((entry): entry is [string, PermissionAction] => normalizePermissionAction(entry[1]) !== undefined)) {
			return undefined;
		}
		return Object.fromEntries(entries);
	} catch {
		return undefined;
	}
}

export function resolvePermissionConfigFromEnv(env: Record<string, string | undefined> = process.env): PTYPermissionConfig {
	const bash = parseBashPermissions(env.OMP_PTY_PERMISSION_BASH);
	const externalDirectory = normalizePermissionAction(env.OMP_PTY_PERMISSION_EXTERNAL_DIRECTORY);
	return {
		...(bash ? { bash } : {}),
		...(externalDirectory ? { external_directory: externalDirectory } : {}),
	};
}

export class PTYPermissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PTYPermissionError";
	}
}

function commandLine(command: string, args: string[]): string {
	return [command, ...args].filter(Boolean).join(" ");
}

function denyAsk(command: string, args: string[]): never {
	const line = commandLine(command, args);
	throw new PTYPermissionError(
		`PTY command "${line}" requires permission (treated as denied). Configure an explicit allow or deny rule in the OMP PTY permission policy.`,
	);
}

export function checkCommandPermission(config: PTYPermissionConfig | undefined, command: string, args: string[]): void {
	const bashPerms = config?.bash;
	if (!bashPerms) return;

	if (typeof bashPerms === "string") {
		if (bashPerms === "deny") {
			throw new PTYPermissionError("PTY command denied: all PTY commands are disabled by the OMP PTY permission policy.");
		}
		if (bashPerms === "ask") denyAsk(command, args);
		return;
	}

	const action = allStructured({ head: command, tail: args }, bashPerms);
	if (action === "deny") {
		throw new PTYPermissionError(
			`PTY command denied: command "${commandLine(command, args)}" is explicitly denied by the OMP PTY permission policy.`,
		);
	}
	if (action === "ask") denyAsk(command, args);
}

function normalizePathForPolicy(value: string): string {
	const resolved = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideDirectory(workdir: string, root: string): boolean {
	const normalizedWorkdir = normalizePathForPolicy(workdir);
	const normalizedRoot = normalizePathForPolicy(root);
	return normalizedWorkdir === normalizedRoot || normalizedWorkdir.startsWith(`${normalizedRoot}/`);
}

export function checkWorkdirPermission(config: PTYPermissionConfig | undefined, workdir: string, cwd: string): void {
	if (!config?.external_directory || config.external_directory === "allow") return;
	if (isInsideDirectory(workdir, cwd)) return;

	if (config.external_directory === "deny") {
		throw new PTYPermissionError(
			`PTY spawn denied: working directory "${workdir}" is outside current OMP cwd "${cwd}". External directory access is denied by the OMP PTY permission policy.`,
		);
	}

	throw new PTYPermissionError(
		`PTY spawn denied: working directory "${workdir}" is outside current OMP cwd "${cwd}" and requires permission (treated as denied).`,
	);
}
