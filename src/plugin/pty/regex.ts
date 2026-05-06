export function validateRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		const dangerousPatterns = [
			/\([^)]*[+*][^)]*\)[+*?{]/,
			/\([^)]*\{[^)]*\}[^)]*\)[+*?{]/,
			/\(\?:.*\)\*.*\(\?:.*\)\*/,
			/.*\(\.\*\?\)\{2,\}.*/,
			/.*\(.*\|.*\)\{3,\}.*/,
		];
		return !dangerousPatterns.some(dangerous => dangerous.test(pattern));
	} catch {
		return false;
	}
}

export function compilePattern(pattern: string, ignoreCase?: boolean): RegExp {
	if (!validateRegex(pattern)) {
		throw new Error(`Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.`);
	}
	try {
		return new RegExp(pattern, ignoreCase ? "i" : "");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid regex pattern '${pattern}': ${message}`);
	}
}
