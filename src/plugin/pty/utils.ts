export function buildSessionNotFoundError(id: string): Error {
	return new Error(`PTY session '${id}' not found. Use pty_list to see active sessions.`);
}

export function withSession<TSession, TResult>(
	manager: { getSession(id: string): TSession | null },
	id: string,
	fn: (session: TSession) => TResult,
	defaultValue: TResult,
): TResult {
	const session = manager.getSession(id);
	if (!session) return defaultValue;
	return fn(session);
}
