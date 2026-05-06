export const ETX = String.fromCharCode(3);
export const EOT = String.fromCharCode(4);

/**
 * Parse literal escape sequences into the bytes sent to the PTY.
 * Mirrors upstream opencode-pty write semantics for \n, \r, \t, \xNN, \uNNNN, and \\.
 */
export function parseEscapeSequences(input: string): string {
	return input.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g, (match, seq: string) => {
		if (seq.startsWith("x")) return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
		if (seq.startsWith("u")) return String.fromCharCode(Number.parseInt(seq.slice(1), 16));
		switch (seq) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "\\":
				return "\\";
			default:
				return match;
		}
	});
}

function stripLeadingControlInput(line: string): string {
	let index = 0;
	while (line[index] === ETX || line[index] === EOT) index += 1;
	return line.slice(index);
}

export function extractCommands(data: string): string[] {
	const commands: string[] = [];
	const lines = data.split(/[\n\r]+/);
	for (const line of lines) {
		const trimmed = stripLeadingControlInput(line.trimStart()).trim();
		if (trimmed) {
			commands.push(trimmed);
		}
	}
	return commands;
}

export function parseCommand(commandLine: string): { command: string; args: string[] } {
	const parts = commandLine.split(/\s+/).filter(Boolean);
	const command = parts[0] ?? "";
	const args = parts.slice(1);
	return { command, args };
}

export function formatWritePreview(data: string): string {
	const preview = data.length > 50 ? `${data.slice(0, 50)}...` : data;
	return preview
		.replace(new RegExp(ETX, "g"), "^C")
		.replace(new RegExp(EOT, "g"), "^D")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r");
}
