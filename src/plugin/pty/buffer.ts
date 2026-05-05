const DEFAULT_MAX_BUFFER_SIZE = Number.parseInt(process.env.PTY_MAX_BUFFER_SIZE || "1000000", 10);
const encoder = new TextEncoder();

export interface SearchMatch {
	lineNumber: number;
	text: string;
}

function byteLength(text: string): number {
	return encoder.encode(text).byteLength;
}

function trimToMaxBytes(text: string, maxSize: number): string {
	if (maxSize <= 0) return "";
	if (byteLength(text) <= maxSize) return text;

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (byteLength(text.slice(mid)) <= maxSize) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}

	return text.slice(low);
}

export class RingBuffer {
	#buffer = "";
	readonly #maxSize: number;

	constructor(maxSize = DEFAULT_MAX_BUFFER_SIZE) {
		this.#maxSize = Math.max(0, Math.floor(maxSize));
	}

	append(data: string): void {
		if (!data) return;
		this.#buffer = trimToMaxBytes(`${this.#buffer}${data}`, this.#maxSize);
	}

	#splitBufferLines(): string[] {
		if (this.#buffer === "") return [];
		const lines = this.#buffer.replace(/\r\n/g, "\n").split("\n");
		if (lines.length && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	}

	read(offset = 0, limit?: number): string[] {
		const lines = this.#splitBufferLines();
		const start = Math.max(0, Math.floor(offset));
		const safeLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
		const end = safeLimit === undefined ? lines.length : start + safeLimit;
		return lines.slice(start, end);
	}

	readRaw(): string {
		return this.#buffer;
	}

	search(pattern: RegExp): SearchMatch[] {
		const matches: SearchMatch[] = [];
		const lines = this.#splitBufferLines();

		for (let i = 0; i < lines.length; i++) {
			pattern.lastIndex = 0;
			if (pattern.test(lines[i])) {
				matches.push({ lineNumber: i, text: lines[i] });
			}
		}
		return matches;
	}

	get length(): number {
		return this.#splitBufferLines().length;
	}

	get byteLength(): number {
		return byteLength(this.#buffer);
	}

	flush(): void {
		// No-op: output is appended as received.
	}

	clear(): void {
		this.#buffer = "";
	}
}
