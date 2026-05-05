import type { PTYSession, ReadResult, SearchResult } from "./types";

export class OutputManager {
	write(session: PTYSession, data: string): boolean {
		try {
			session.process?.write(data);
			return session.status === "running";
		} catch {
			return false;
		}
	}

	read(session: PTYSession, offset = 0, limit?: number): ReadResult {
		const safeOffset = Math.max(0, Math.floor(offset));
		const lines = session.buffer.read(safeOffset, limit);
		const totalLines = session.buffer.length;
		const hasMore = safeOffset + lines.length < totalLines;
		return { lines, totalLines, offset: safeOffset, hasMore };
	}

	search(session: PTYSession, pattern: RegExp, offset = 0, limit?: number): SearchResult {
		const safeOffset = Math.max(0, Math.floor(offset));
		const allMatches = session.buffer.search(pattern);
		const totalMatches = allMatches.length;
		const totalLines = session.buffer.length;
		const paginatedMatches =
			limit !== undefined ? allMatches.slice(safeOffset, safeOffset + Math.max(0, Math.floor(limit))) : allMatches.slice(safeOffset);
		const hasMore = safeOffset + paginatedMatches.length < totalMatches;
		return { matches: paginatedMatches, totalMatches, totalLines, offset: safeOffset, hasMore };
	}
}
