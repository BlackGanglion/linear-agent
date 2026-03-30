/** In-memory session state for active agent sessions */
export interface SessionState {
  sessionId: string;
  issueId: string;
  status: "active" | "completing" | "completed" | "stopped" | "error";
  abortController: AbortController;
  lastActivityAt: number;
  createdAt: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();

  create(sessionId: string, issueId: string): SessionState {
    // If session already exists, abort the old one
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "active") {
      existing.abortController.abort();
    }

    const state: SessionState = {
      sessionId,
      issueId,
      status: "active",
      abortController: new AbortController(),
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  markActivity(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.lastActivityAt = Date.now();
    }
  }

  stop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.status = "stopped";
      state.abortController.abort();
    }
  }

  complete(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.status = "completed";
      // Keep in map briefly for dedup, clean up later
    }
  }

  markError(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.status = "error";
    }
  }

  /** Remove sessions older than maxAgeMs */
  cleanup(maxAgeMs: number = 3_600_000): void {
    const now = Date.now();
    for (const [id, state] of this.sessions) {
      if (state.status !== "active" && now - state.createdAt > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}
