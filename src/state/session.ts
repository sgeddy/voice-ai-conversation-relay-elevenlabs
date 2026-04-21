import Anthropic from '@anthropic-ai/sdk';

type MessageParam = Anthropic.Messages.MessageParam;

export interface SessionState {
  id: string;
  from?: string;
  to?: string;
  messages: MessageParam[];
  createdAt: number;
}

/**
 * Session-state store. v1 is an in-memory Map keyed by session_id.
 * For production, swap this implementation for a Redis-backed adapter
 * that implements the same interface — conversation state is not
 * trivially recoverable if the process restarts with Map-only storage.
 */
export interface SessionStore {
  get(id: string): SessionState | undefined;
  getOrCreate(id: string, init?: Partial<SessionState>): SessionState;
  delete(id: string): void;
}

class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id: string, init: Partial<SessionState> = {}): SessionState {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const fresh: SessionState = {
      id,
      messages: [],
      createdAt: Date.now(),
      ...init,
    };
    this.sessions.set(id, fresh);
    return fresh;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}

export const sessionStore: SessionStore = new MemorySessionStore();
