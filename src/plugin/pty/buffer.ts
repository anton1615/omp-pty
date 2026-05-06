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

interface SanitizedTerminalLine {
	text: string;
	incomplete: boolean;
}

function sanitizeTerminalControls(text: string): SanitizedTerminalLine {
	let output = "";
	let incomplete = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\x1B") {
			const next = text[i + 1];
			if (next === undefined) {
				incomplete = true;
				break;
			}

			if (next === "[") {
				i += 2;
				while (i < text.length) {
					const code = text.charCodeAt(i);
					if (code >= 0x40 && code <= 0x7e) break;
					i += 1;
				}
				if (i >= text.length) incomplete = true;
				continue;
			}

			if (next === "]") {
				i += 2;
				let terminated = false;
				while (i < text.length) {
					if (text.charCodeAt(i) === 0x07) {
						terminated = true;
						break;
					}
					if (text[i] === "\x1B" && text[i + 1] === "\\") {
						i += 1;
						terminated = true;
						break;
					}
					i += 1;
				}
				if (!terminated) incomplete = true;
				continue;
			}

			if (next === "P" || next === "^" || next === "_" || next === "X") {
				i += 2;
				let terminated = false;
				while (i < text.length) {
					if (text[i] === "\x1B" && text[i + 1] === "\\") {
						i += 1;
						terminated = true;
						break;
					}
					i += 1;
				}
				if (!terminated) incomplete = true;
				continue;
			}

			i += 1;
			continue;
		}

		const code = char.charCodeAt(0);
		if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
			continue;
		}
		output += char;
	}

	return { text: output, incomplete };
}

function stripTerminalControls(text: string): string {
	return sanitizeTerminalControls(text).text;
}

function findLastDisplayLine(text: string): string {
	let end = text.length;
	while (end > 0) {
		while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
			end -= 1;
		}
		if (end === 0) return "";

		let start = end;
		while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "\r") {
			start -= 1;
		}

		const displayLine = stripTerminalControls(text.slice(start, end)).trim();
		if (displayLine !== "") return displayLine;
		end = start;
	}
	return "";
}

function findLastNonEmptyLine(text: string): string {
	let end = text.length;
	while (end > 0) {
		while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
			end -= 1;
		}
		if (end === 0) return "";

		let start = end;
		while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "\r") {
			start -= 1;
		}

		const line = text.slice(start, end);
		if (line.trim() !== "") return line;
		end = start;
	}
	return "";
}

function countBufferLines(text: string): number {
	if (text === "") return 0;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count += 1;
	}
	return text.endsWith("\n") ? count - 1 : count;
}

export class RingBuffer {
	#buffer = "";
	#lastNonEmptyLine = "";
	#lastDisplayLine = "";
	#currentDisplayRawLine = "";
	#lineCount = 0;
	readonly #maxSize: number;

	constructor(maxSize = DEFAULT_MAX_BUFFER_SIZE) {
		this.#maxSize = Math.max(0, Math.floor(maxSize));
	}

	#commitCurrentDisplayLine(): void {
		const display = sanitizeTerminalControls(this.#currentDisplayRawLine);
		const displayLine = display.text.trim();
		if (!display.incomplete && displayLine !== "") this.#lastDisplayLine = displayLine;
	}

	#updateLastDisplayLine(data: string): void {
		for (const part of data.split(/(\r\n|\n|\r)/)) {
			if (part === "") continue;
			if (part === "\r\n" || part === "\n" || part === "\r") {
				this.#commitCurrentDisplayLine();
				this.#currentDisplayRawLine = "";
				continue;
			}

			this.#currentDisplayRawLine = trimToMaxBytes(`${this.#currentDisplayRawLine}${part}`, this.#maxSize);
			this.#commitCurrentDisplayLine();
		}
	}

	append(data: string): void {
		if (!data) return;
		const combined = `${this.#buffer}${data}`;
		this.#buffer = trimToMaxBytes(combined, this.#maxSize);
		this.#lastNonEmptyLine = findLastNonEmptyLine(this.#buffer);
		this.#updateLastDisplayLine(data);
		if (combined.length !== this.#buffer.length && this.#lastDisplayLine && !this.#buffer.includes(this.#lastDisplayLine)) {
			this.#lastDisplayLine = findLastDisplayLine(this.#buffer);
		}
		this.#lineCount = countBufferLines(this.#buffer);
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
				matches.push({ lineNumber: i + 1, text: lines[i] });
			}
		}
		return matches;
	}

	get length(): number {
		return this.#lineCount;
	}

	get byteLength(): number {
		return byteLength(this.#buffer);
	}

	getLastNonEmptyLine(): string {
		return this.#lastNonEmptyLine;
	}

	getLastDisplayLine(): string {
		return this.#lastDisplayLine;
	}

	getLineCount(): number {
		return this.#lineCount;
	}

	flush(): void {
		// No-op: output is appended as received.
	}

	clear(): void {
		this.#buffer = "";
		this.#lastNonEmptyLine = "";
		this.#lastDisplayLine = "";
		this.#currentDisplayRawLine = "";
		this.#lineCount = 0;
	}
}
