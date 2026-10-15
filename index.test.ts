import { afterEach, describe, expect, it } from "bun:test";
import { RingBuffer } from "./src/plugin/pty/buffer";
import { PTYManager } from "./src/plugin/pty/manager";
import type { ManagedPTYProcess, PTYProcessSpawner, PTYSession } from "./src/plugin/pty/types";
import { formatExitNotification } from "./src/plugin/pty/notification-manager";
import defaultOmpPtyExtension, { createOmpPtyExtension } from "./src/omp/extension";

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

type RegisteredTool = { execute: Function };
type RegisteredEventHandler = (event: unknown, ctx: ReturnType<typeof createToolContext>) => unknown;

function createToolContext(sessionId = "session-main", cwd = "C:/work/project") {
	return {
		cwd,
		hasUI: false,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => sessionId },
	};
}

function createExtensionHarness(extensionOrManager: PTYManager | ((pi: any) => void)) {
	const tools = new Map<string, RegisteredTool>();
	const messages: Array<{ content: string; options: unknown }> = [];
	const events = new Map<string, RegisteredEventHandler[]>();
	const Type = {
		Object: (properties: Record<string, unknown>) => ({ type: "object", properties }),
		String: (options?: Record<string, unknown>) => ({ type: "string", options }),
		Number: (options?: Record<string, unknown>) => ({ type: "number", options }),
		Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", options }),
		Array: (item: unknown, options?: Record<string, unknown>) => ({ type: "array", item, options }),
		Record: (key: unknown, value: unknown, options?: Record<string, unknown>) => ({ type: "record", key, value, options }),
		Optional: (schema: unknown) => ({ optional: true, schema }),
	};

	const extension = extensionOrManager instanceof PTYManager ? createOmpPtyExtension(extensionOrManager) : extensionOrManager;
	extension({
		typebox: { Type },
		registerTool: tool => tools.set(tool.name, tool),
		registerCommand: () => undefined,
		on: (eventName, handler) => {
			const handlers = events.get(eventName) ?? [];
			handlers.push(handler as RegisteredEventHandler);
			events.set(eventName, handlers);
		},
		sendMessage: (message, options) => messages.push({ content: message.content, options }),
	});

	return { tools, messages, events };
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

		const adapterSource = await Bun.file("src/omp/extension.ts").text();
		for (const file of ["src/plugin/pty/formatters.ts", "src/plugin/pty/input.ts", "src/plugin/pty/permissions.ts", "src/plugin/pty/wildcard.ts"]) {
			expect(await Bun.file(file).exists()).toBe(true);
		}
		expect(adapterSource).toContain("../plugin/pty/formatters");
		expect(adapterSource).toContain("../plugin/pty/input");
		expect(adapterSource).toContain("../plugin/pty/permissions");
		expect(adapterSource).not.toContain("function formatReadResult");
		expect(adapterSource).not.toContain("function parseEscapeSequences");
		expect(adapterSource).not.toContain("function validateRegex");
	});

	it("drops the obsoleted bun-pty read-loop workaround", async () => {
		const spawnerSource = await Bun.file("src/plugin/pty/process-spawner.ts").text();

		expect(spawnerSource).not.toContain("Terminal.prototype");
		expect(spawnerSource).not.toContain("_startReadLoop");
		expect(spawnerSource).not.toContain("too new for patching");
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

	it("reports regex search matches with one-based line numbers", () => {
		const buffer = new RingBuffer(1024);

		buffer.append("alpha\nbeta\n");

		expect(buffer.search(/beta/)).toEqual([{ lineNumber: 2, text: "beta" }]);
	});

	it("tracks line count and the last non-empty line without notification-time full reads", () => {
		const buffer = new RingBuffer(1024);

		buffer.append("first\n");
		buffer.append("last useful\n\n\n");

		expect(buffer.getLineCount()).toBe(4);
		expect(buffer.getLastNonEmptyLine()).toBe("last useful");
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

		spawned[0].emit("starting\nready\n");
		spawned[0].exit(0);

		expect(manager.get(info.id)).toEqual(expect.objectContaining({ status: "exited", exitCode: 0 }));
		expect(notifications).toEqual([
			[
				"<pty_exited>",
				`ID: ${info.id}`,
				"Description: Run dev server",
				"Exit Code: 0",
				"TimeoutSeconds: none",
				"Timed Out: no",
				"Output Lines: 2",
				"Last Line: ready",
				"</pty_exited>",
				"",
				"Use pty_read to check the full output.",
			].join("\n"),
		]);
	});
	it("uses the last human-readable terminal line in exit notifications", () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });
		const info = manager.spawn({
			command: "cmd.exe",
			args: ["/c", "echo OMP_PTY_RESTART_OK"],
			workdir: "C:/work/project",
			description: "Restart smoke",
			notifyOnExit: true,
		});

		spawned[0].emit("\x1b[2J\x1b[m\x1b[HOMP_PTY_RESTART_OK\n\x1b]0;C:\\Windows\\system32\\cmd.exe\x07\x1b[?25h\n");
		spawned[0].exit(0);

		expect(notifications[0]).toContain(`ID: ${info.id}`);
		expect(notifications[0]).toContain("Last Line: OMP_PTY_RESTART_OK");
		expect(notifications[0]).not.toContain("\x1b]");
	});

	it("ignores terminal controls split across data events in exit notifications", () => {
		const manager = new PTYManager({ spawner, notify: message => notifications.push(message) });
		const info = manager.spawn({
			command: "cmd.exe",
			args: ["/c", "echo OMP_PTY_RESTART_OK"],
			workdir: "C:/work/project",
			description: "Restart smoke",
			notifyOnExit: true,
		});

		spawned[0].emit("OMP_PTY_RESTART_OK\n");
		spawned[0].emit("\x1b]0;C:");
		spawned[0].emit("\\Windows\\system32\\cmd.exe\x07");
		spawned[0].emit("\x1b[?25");
		spawned[0].emit("h\n");
		spawned[0].exit(0);

		expect(notifications[0]).toContain(`ID: ${info.id}`);
		expect(notifications[0]).toContain("Last Line: OMP_PTY_RESTART_OK");
		expect(notifications[0]).not.toContain("]0;C:");
		expect(notifications[0]).not.toContain("[?25");
	});

	it("finds the last notification line without reading the full buffer", () => {
		const session = {
			id: "pty_perf",
			title: "notify perf",
			command: "cmd.exe",
			args: [],
			workdir: "C:/work/project",
			status: "exited",
			exitCode: 0,
			pid: 1234,
			createdAt: new Date(),
			notifyOnExit: true,
			timedOut: false,
			process: null,
			buffer: {
				get length() {
					throw new Error("notification must use cached line count");
				},
				getLineCount: () => 201,
				read: () => {
					throw new Error("notification must not read the full buffer");
				},
				getLastNonEmptyLine: () => "last useful",
				getLastDisplayLine: () => "last useful",
				readRaw: () => "last useful\n\n",
				search: () => [],
				byteLength: "last useful\n\n".length,
				append: () => undefined,
				flush: () => undefined,
				clear: () => undefined,
			},
		} as unknown as PTYSession;

		expect(formatExitNotification(session)).toContain("Last Line: last useful");
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
		expect(notifications[0]).toContain("Timed Out: yes");
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
		expect(manager.list()[0].exitAt).toBeTypeOf("string");

		expect(messages).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("<pty_exited>"),
				options: { deliverAs: "nextTurn", triggerTurn: true },
			}),
		]);
	});

	it("parses literal escape sequences in pty_write before writing", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3100, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(manager);
		const spawnTool = tools.get("pty_spawn");
		const writeTool = tools.get("pty_write");
		expect(spawnTool).toBeDefined();
		expect(writeTool).toBeDefined();

		const spawnResult = await spawnTool!.execute(
			"call-1",
			{ command: "cmd.exe", args: [] },
			undefined,
			undefined,
			{ cwd: "C:/work/project", hasUI: false, ui: { notify: () => undefined } },
		);
		const id = spawnResult.details.id;

		const writeResult = await writeTool!.execute("call-2", { id, data: "first\\n\\x03\\u0041\\\\" });

		expect(writeResult.isError).toBeUndefined();
		expect(spawned[0].writes).toEqual([`first\n${String.fromCharCode(3)}A\\`]);
		expect(writeResult.content[0].text).toContain("^C");
	});

	it("does not write to exited PTY sessions", () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3200, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const info = manager.spawn({ command: "node", args: [], workdir: "C:/work/project" });

		spawned[0].exit(0);

		expect(manager.write(info.id, "after exit\n")).toBe(false);
		expect(spawned[0].writes).toEqual([]);
	});

	it("formats pty_read with upstream defaults and case-sensitive regex by default", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3300, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(manager);
		const spawnResult = await tools.get("pty_spawn")!.execute(
			"call-1",
			{ command: "node", args: [] },
			undefined,
			undefined,
			{ cwd: "C:/work/project", hasUI: false, ui: { notify: () => undefined } },
		);
		const id = spawnResult.details.id;
		spawned[0].emit(`${Array.from({ length: 501 }, (_, index) => `line ${index + 1}`).join("\n")}\nERROR upper\n`);

		const plainResult = await tools.get("pty_read")!.execute("call-2", { id });
		const plainText = plainResult.content[0].text;

		expect(plainText).toContain(`<pty_output id="${id}" status="running">`);
		expect(plainText.match(/^\d{5}\|/gm)).toHaveLength(500);
		expect(plainText).toContain("00001| line 1");
		expect(plainText).not.toContain("00501| line 501");
		expect(plainText).toContain("Use offset=500");

		const caseSensitiveResult = await tools.get("pty_read")!.execute("call-3", { id, pattern: "error" });
		expect(caseSensitiveResult.content[0].text).toContain("No lines matched the pattern 'error'.");

		const ignoreCaseResult = await tools.get("pty_read")!.execute("call-4", { id, pattern: "error", ignoreCase: true });
		expect(ignoreCaseResult.content[0].text).toContain("00502| ERROR upper");

		const dangerousRegexResult = await tools.get("pty_read")!.execute("call-5", { id, pattern: "(a+)+$" });
		expect(dangerousRegexResult.isError).toBe(true);
		expect(dangerousRegexResult.content[0].text).toContain("Potentially dangerous regex pattern rejected");

		const outOfRangeResult = await tools.get("pty_read")!.execute("call-6", { id, offset: 999, limit: 10 });
		expect(outOfRangeResult.content[0].text).toContain("Offset 999 is beyond available output");
	});
});

describe("OMP PTY permission and session policy", () => {
	it("denies pty_spawn commands blocked by the OMP PTY permission policy", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3600, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(createOmpPtyExtension(manager, { permissions: { bash: { npm: "deny" } } }));

		const result = await tools.get("pty_spawn")!.execute("call-1", { command: "npm", args: ["run", "dev"] }, undefined, undefined, createToolContext());

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("explicitly denied");
		expect(spawned).toHaveLength(0);
	});

	it("loads OMP PTY permission policy from environment by default", async () => {
		const previous = process.env.OMP_PTY_PERMISSION_BASH;
		process.env.OMP_PTY_PERMISSION_BASH = JSON.stringify({ npm: "deny" });
		try {
			const spawned: FakeProcess[] = [];
			const spawner: PTYProcessSpawner = options => {
				const process = new FakeProcess(3650, options.onData, options.onExit);
				spawned.push(process);
				return process;
			};
			const manager = new PTYManager({ spawner });
			const { tools } = createExtensionHarness(createOmpPtyExtension(manager));

			const result = await tools.get("pty_spawn")!.execute("call-1", { command: "npm", args: ["run", "dev"] }, undefined, undefined, createToolContext());

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("explicitly denied");
			expect(spawned).toHaveLength(0);
		} finally {
			if (previous === undefined) {
				delete process.env.OMP_PTY_PERMISSION_BASH;
			} else {
				process.env.OMP_PTY_PERMISSION_BASH = previous;
			}
		}
	});

	it("denies pty_write commands blocked by the OMP PTY permission policy", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3700, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(createOmpPtyExtension(manager, { permissions: { bash: { "rm *": "deny" } } }));
		const spawnResult = await tools.get("pty_spawn")!.execute("call-1", { command: "sh", args: [] }, undefined, undefined, createToolContext());
		const id = spawnResult.details.id;

		const denied = await tools.get("pty_write")!.execute("call-2", { id, data: "rm -rf temp\n" }, undefined, undefined, createToolContext());
		const prefixedDenied = await tools.get("pty_write")!.execute("call-3", { id, data: "\\x03rm -rf temp\n" }, undefined, undefined, createToolContext());
		const interrupt = await tools.get("pty_write")!.execute("call-4", { id, data: "\\x03" }, undefined, undefined, createToolContext());

		expect(denied.isError).toBe(true);
		expect(prefixedDenied.isError).toBe(true);
		expect(denied.content[0].text).toContain("explicitly denied");
		expect(prefixedDenied.content[0].text).toContain("explicitly denied");
		expect(interrupt.isError).toBeUndefined();
		expect(spawned[0].writes).toEqual([String.fromCharCode(3)]);
	});

	it("denies pty_spawn workdirs outside cwd when external directory policy denies", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3800, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(createOmpPtyExtension(manager, { permissions: { external_directory: "deny" } }));

		const result = await tools.get("pty_spawn")!.execute(
			"call-1",
			{ command: "node", args: [], workdir: "/tmp/outside" },
			undefined,
			undefined,
			createToolContext("session-main", "/repo/app"),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("outside current OMP cwd");
		expect(spawned).toHaveLength(0);
	});

	it("scopes PTY tools to the current OMP session by default", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3400, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools } = createExtensionHarness(manager);
		const sessionA = createToolContext("session-a");
		const sessionB = createToolContext("session-b");

		const spawnResult = await tools.get("pty_spawn")!.execute("call-1", { command: "node", args: [] }, undefined, undefined, sessionA);
		const id = spawnResult.details.id;
		spawned[0].emit("session a output\n");

		expect((await tools.get("pty_list")!.execute("call-2", {}, undefined, undefined, sessionA)).content[0].text).toContain(id);
		expect((await tools.get("pty_list")!.execute("call-3", {}, undefined, undefined, sessionB)).content[0].text).not.toContain(id);
		expect((await tools.get("pty_list")!.execute("call-4", { all: true }, undefined, undefined, sessionB)).content[0].text).toContain(id);

		const crossRead = await tools.get("pty_read")!.execute("call-5", { id }, undefined, undefined, sessionB);
		expect(crossRead.isError).toBe(true);
		expect(crossRead.content[0].text).toContain("current OMP session");

		const crossWrite = await tools.get("pty_write")!.execute("call-6", { id, data: "oops\n" }, undefined, undefined, sessionB);
		expect(crossWrite.isError).toBe(true);
		expect(spawned[0].writes).toEqual([]);

		const crossKill = await tools.get("pty_kill")!.execute("call-7", { id, cleanup: true }, undefined, undefined, sessionB);
		expect(crossKill.isError).toBe(true);
		expect(spawned[0].killed).toBe(false);
	});

	it("cleans up current-session PTYs after a confirmed session switch", async () => {
		const spawned: FakeProcess[] = [];
		const spawner: PTYProcessSpawner = options => {
			const process = new FakeProcess(3500, options.onData, options.onExit);
			spawned.push(process);
			return process;
		};
		const manager = new PTYManager({ spawner });
		const { tools, events } = createExtensionHarness(manager);
		const sessionA = createToolContext("session-a");
		const sessionB = createToolContext("session-b");

		await tools.get("pty_spawn")!.execute("call-1", { command: "node", args: [] }, undefined, undefined, sessionA);
		expect(manager.list()).toHaveLength(1);

		await events.get("session_before_switch")![0]({ type: "session_before_switch", reason: "new" }, sessionA);
		expect(manager.list()).toHaveLength(1);

		await events.get("session_switch")![0]({ type: "session_switch", reason: "new", previousSessionFile: "old.json" }, sessionB);
		expect(spawned[0].killed).toBe(true);
		expect(manager.list()).toHaveLength(0);
	});

	it("creates a fresh PTY manager for each default extension registration", async () => {
		const first = createExtensionHarness(defaultOmpPtyExtension);
		const second = createExtensionHarness(defaultOmpPtyExtension);
		const isWindows = process.platform === "win32";
		const spawnResult = await first.tools.get("pty_spawn")!.execute(
			"call-1",
			{
				command: isWindows ? "cmd.exe" : "sh",
				args: isWindows ? ["/c", "echo default-manager-isolation"] : ["-lc", "echo default-manager-isolation"],
			},
			undefined,
			undefined,
			createToolContext("session-a", process.cwd()),
		);
		const id = spawnResult.details.id;

		expect((await second.tools.get("pty_list")!.execute("call-2", { all: true }, undefined, undefined, createToolContext("session-a", process.cwd()))).content[0].text).not.toContain(id);
		await first.tools.get("pty_kill")!.execute("call-3", { id, cleanup: true }, undefined, undefined, createToolContext("session-a", process.cwd()));
	});
});
