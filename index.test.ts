import { afterEach, describe, expect, it } from "bun:test";
import { RingBuffer } from "./src/plugin/pty/buffer";
import { PTYManager } from "./src/plugin/pty/manager";
import type { ManagedPTYProcess, PTYProcessSpawner } from "./src/plugin/pty/types";
import { createOmpPtyExtension } from "./src/omp/extension";

class FakeProcess implements ManagedPTYProcess {
	pid: number;
	killed = false;
	closed = false;
	writes: string[] = [];
	subscriptionsClosed = false;
	#onData: (data: string) => void;
	#onExit: (exitCode: number | null, signalCode: string | null) => void;

	constructor(
		pid: number,
		onData: (data: string) => void,
		onExit: (exitCode: number | null, signalCode: string | null) => void,
	) {
		this.pid = pid;
		this.#onData = onData;
		this.#onExit = onExit;
	}

	emit(data: string): void {
		this.#onData(data);
	}

	exit(exitCode: number | null = 0, signalCode: string | null = null): void {
		if (this.subscriptionsClosed) return;
		this.#onExit(exitCode, signalCode);
	}

	write(data: string): void {
		this.writes.push(data);
	}

	kill(): void {
		this.killed = true;
	}

	close(): void {
		this.closed = true;
		this.subscriptionsClosed = true;
	}
}

describe("upstream-port architecture", () => {
	it("keeps upstream-shaped core files separate from the OMP adapter", async () => {
		const expectedFiles = [
			"src/plugin/pty/buffer.ts",
			"src/plugin/pty/output-manager.ts",
			"src/plugin/pty/session-lifecycle.ts",
			"src/plugin/pty/notification-manager.ts",
			"src/plugin/pty/manager.ts",
			"src/plugin/pty/types.ts",
			"src/plugin/pty/process-spawner.ts",
			"src/omp/extension.ts",
		];

		for (const file of expectedFiles) {
			expect(await Bun.file(file).exists()).toBe(true);
		}

		const entry = await Bun.file("index.ts").text();
		expect(entry.trim()).toBe('export { default, createOmpPtyExtension, createOpenCodePtyExtension } from "./src/omp/extension";');
	});

	it("keeps upstream bun-pty read-loop workaround in the spawner", async () => {
		const spawnerSource = await Bun.file("src/plugin/pty/process-spawner.ts").text();

		expect(spawnerSource).toContain("Terminal.prototype");
		expect(spawnerSource).toContain("_startReadLoop");
		expect(spawnerSource).toContain("await Promise.resolve()");
	});
});

describe("RingBuffer", () => {
	it("reads paginated terminal lines and reports remaining lines", () => {
		const buffer = new RingBuffer(1024);

		buffer.append("first\nsecond\nthird\n");

		expect(buffer.read(1, 1)).toEqual(["second"]);
		expect(buffer.length).toBe(3);
	});

	it("drops oldest content when the raw buffer exceeds the byte limit", () => {
		const buffer = new RingBuffer(10);

		buffer.append("12345");
		buffer.append("67890");
		buffer.append("abc");

		expect(buffer.readRaw()).toBe("4567890abc");
	});

	it("trims large overflow chunks without blocking on quadratic work", () => {
		const buffer = new RingBuffer(8192);
		const chunk = "x".repeat(32768);

		const startedAt = performance.now();
		buffer.append(chunk);
		const elapsedMs = performance.now() - startedAt;

		expect(buffer.byteLength).toBe(8192);
		expect(buffer.readRaw()).toBe("x".repeat(8192));
		expect(elapsedMs).toBeLessThan(120);
	});
});

describe("PTYManager", () => {
	const spawned: FakeProcess[] = [];
	const notifications: string[] = [];
	let nextPid = 2000;

	const spawner: PTYProcessSpawner = options => {
		const process = new FakeProcess(nextPid++, options.onData, options.onExit);
		spawned.push(process);
		return process;
	};

	afterEach(() => {
		spawned.splice(0, spawned.length);
		notifications.splice(0, notifications.length);
		nextPid = 2000;
	});

	it("spawns a PTY session, captures output, writes input, and lists session metadata", () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });

		const info = manager.spawn({
			command: "bun",
			args: ["--version"],
			workdir: "C:/work/project",
			description: "Check Bun version",
			notifyOnExit: false,
		});

		spawned[0].emit("line one\nline two\n");

		expect(manager.write(info.id, "echo done\n")).toBe(true);
		expect(spawned[0].writes).toEqual(["echo done\n"]);
		expect(manager.read(info.id, 0, 1)).toEqual({
			lines: ["line one"],
			totalLines: 2,
			offset: 0,
			hasMore: true,
		});
		expect(manager.list()).toEqual([
			expect.objectContaining({
				id: info.id,
				command: "bun",
				args: ["--version"],
				workdir: "C:/work/project",
				status: "running",
				pid: 2000,
				lineCount: 2,
			}),
		]);
	});

	it("marks exited notify-on-exit sessions and emits a completion message", () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });

		const info = manager.spawn({
			command: "npm",
			args: ["run", "dev"],
			workdir: "C:/work/project",
			description: "Run dev server",
			notifyOnExit: true,
		});

		spawned[0].exit(0);

		expect(manager.get(info.id)).toEqual(expect.objectContaining({ status: "exited", exitCode: 0 }));
		expect(notifications).toEqual([
			[
				"<pty_exited>",
				`ID: ${info.id}`,
				"Title: npm run dev",
				"Command: npm run dev",
				"Workdir: C:/work/project",
				"ExitCode: 0",
				"Signal: none",
				"TimedOut: false",
				"</pty_exited>",
			].join("\n"),
		]);
	});

	it("kills and removes sessions when cleanup is requested", () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });
		const info = manager.spawn({ command: "node", args: [], workdir: "C:/work/project" });

		expect(manager.kill(info.id, true)).toBe(true);

		expect(spawned[0].killed).toBe(true);
		expect(spawned[0].closed).toBe(true);
		expect(manager.get(info.id)).toBeNull();
	});

	it("keeps timeout-killed notify-on-exit sessions observable until exit", async () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });
		const info = manager.spawn({
			command: "npm",
			args: ["run", "watch"],
			workdir: "C:/work/project",
			notifyOnExit: true,
			timeoutSeconds: 0.01,
		});

		await Bun.sleep(30);

		expect(spawned[0].killed).toBe(true);
		expect(spawned[0].closed).toBe(false);

		spawned[0].exit(null, "SIGTERM");

		expect(manager.get(info.id)).toEqual(expect.objectContaining({ status: "killed", timedOut: true }));
		expect(notifications[0]).toContain("TimedOut: true");
	});

	it("spawns a real shell PTY and captures output", async () => {
		const messages: string[] = [];
		const manager = new PTYManager({ notify: message => messages.push(message) });
		const isWindows = process.platform === "win32";

		const info = manager.spawn({
			command: isWindows ? "cmd.exe" : "sh",
			args: isWindows ? ["/c", "echo omp-pty-smoke"] : ["-lc", "echo omp-pty-smoke"],
			workdir: process.cwd(),
			notifyOnExit: true,
		});

		let lines: string[] = [];
		let status: string | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			await Bun.sleep(50);
			lines = manager.read(info.id, 0, 20)?.lines ?? [];
			status = manager.get(info.id)?.status;
			if (status === "exited" && lines.some(line => line.includes("omp-pty-smoke"))) break;
		}

		manager.clearAllSessions();

		expect(status).toBe("exited");
		expect(lines.some(line => line.includes("omp-pty-smoke"))).toBe(true);
		expect(messages).toHaveLength(1);
	});
});

describe("opencodePtyExtension", () => {
	it("registers OMP tools that spawn with current cwd and queue notify-on-exit messages", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3000, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const tools = new Map<string, { execute: Function }>();
		const messages: Array<{ content: string; options: unknown }> = [];
		const Type = {
			Object: (properties: Record<string, unknown>) => ({ type: "object", properties }),
			String: (options?: Record<string, unknown>) => ({ type: "string", options }),
			Number: (options?: Record<string, unknown>) => ({ type: "number", options }),
			Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", options }),
			Array: (item: unknown, options?: Record<string, unknown>) => ({ type: "array", item, options }),
			Record: (key: unknown, value: unknown, options?: Record<string, unknown>) => ({ type: "record", key, value, options }),
			Optional: (schema: unknown) => ({ optional: true, schema }),
		};

		createOmpPtyExtension(manager)({
			typebox: { Type },
			registerTool: tool => tools.set(tool.name, tool),
			registerCommand: () => undefined,
			on: () => undefined,
			sendMessage: (message, options) => messages.push({ content: message.content, options }),
		});

		const spawnTool = tools.get("pty_spawn");
		expect(spawnTool).toBeDefined();
		const spawnResult = await spawnTool!.execute(
			"call-1",
			{ command: "npm", args: ["run", "dev"], notifyOnExit: true },
			undefined,
			undefined,
			{ cwd: "C:/work/project", hasUI: false, ui: { notify: () => undefined } },
		);

		expect(spawnResult.content[0].text).toContain("<pty_spawned>");
		expect(manager.list()[0]).toEqual(expect.objectContaining({ workdir: "C:/work/project", notifyOnExit: true }));

		spawned[0].exit(0);

		expect(messages).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("<pty_exited>"),
				options: { deliverAs: "nextTurn", triggerTurn: true },
			}),
		]);
	});
});
