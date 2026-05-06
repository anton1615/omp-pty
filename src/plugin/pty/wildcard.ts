export type StructuredCommand = { head: string; tail: string[] };

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function wildcardToRegExp(pattern: string): RegExp {
	const source = pattern
		.split("")
		.map(char => {
			if (char === "*") return ".*";
			if (char === "?") return ".";
			return escapeRegex(char);
		})
		.join("");
	return new RegExp(`^${source}$`);
}

function matchesToken(pattern: string, value: string): boolean {
	return wildcardToRegExp(pattern).test(value);
}

export function matchesStructured(command: StructuredCommand, pattern: string): boolean {
	const parts = pattern.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return false;
	if (!matchesToken(parts[0], command.head)) return false;
	const argPatterns = parts.slice(1);
	if (argPatterns.length === 0) return true;
	if (argPatterns.length > command.tail.length) return false;
	for (let index = 0; index < argPatterns.length; index += 1) {
		if (!matchesToken(argPatterns[index], command.tail[index] ?? "")) return false;
	}
	return argPatterns.length === command.tail.length || argPatterns[argPatterns.length - 1] === "*";
}

export function allStructured<TAction>(command: StructuredCommand, patterns: Record<string, TAction>): TAction | undefined {
	for (const [pattern, action] of Object.entries(patterns)) {
		if (matchesStructured(command, pattern)) return action;
	}
	return undefined;
}
