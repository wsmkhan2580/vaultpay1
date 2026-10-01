import { Response } from "express";
import { logger } from "../utils/logger";

/**
 * In-memory registry of open Server-Sent-Events connections, keyed by user id.
 * One user can have several tabs open, so each user maps to a SET of responses.
 *
 * Nothing sensitive is ever pushed through this channel: events only carry ids
 * ("invoice X changed"). The browser then re-fetches through the normal,
 * authenticated and ownership-checked API endpoints.
 *
 * Note: this lives in the memory of ONE server process. That is fine for a
 * single Render instance; with several instances you would need Redis pub/sub.
 */
const connections = new Map<string, Set<Response>>();

/** Registers a connection. Returns a function that removes it again. */
export function addConnection(userId: string, res: Response): () => void {
  let set = connections.get(userId);
  if (!set) {
    set = new Set<Response>();
    connections.set(userId, set);
  }
  const mine = set;
  mine.add(res);
  return () => {
    mine.delete(res);
    if (mine.size === 0 && connections.get(userId) === mine) connections.delete(userId);
  };
}

/** Pushes one event to every open tab of a user. Never throws. */
export function emitToUser(userId: string, event: string, data: Record<string, unknown> = {}): void {
  const set = connections.get(userId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch (err) {
      logger.warn("Realtime write failed", { event, error: err instanceof Error ? err.message : "unknown" });
    }
  }
}