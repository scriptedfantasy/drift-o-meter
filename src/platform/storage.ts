/**
 * Session persistence. `listSessions()` reads only the small index; bodies are loaded on demand.
 * Native: AsyncStorage index + JSON files in the documents directory. Web: localStorage.
 */
import type { Session } from '../engine/types';
import { backend } from './sessionBackend';
import { createSessionStore, type SessionIndexEntry } from './sessionStore';

export { StorageError } from './kvTypes';
export { isValidSessionId, newSessionId, summarizeSession } from './sessionStore';
export type { SessionBackend, SessionIndexEntry, SessionStore } from './sessionStore';

export const sessionStore = createSessionStore(backend);

export function listSessions(): Promise<SessionIndexEntry[]> {
  return sessionStore.listSessions();
}

export function loadSession(id: string): Promise<Session | null> {
  return sessionStore.loadSession(id);
}

export function saveSession(session: Session): Promise<SessionIndexEntry> {
  return sessionStore.saveSession(session);
}

export function deleteSession(id: string): Promise<void> {
  return sessionStore.deleteSession(id);
}

export function clearSessions(): Promise<void> {
  return sessionStore.clearSessions();
}
