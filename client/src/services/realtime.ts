import { useEffect, useRef } from 'react';
import { api, getAccessToken } from './api';

/**
 * Live updates from the server (Server-Sent Events over fetch).
 *
 * - One shared connection for the whole app, opened when the first page subscribes and closed when the
 *   last one leaves.
 * - fetch() is used instead of EventSource because EventSource cannot send the Authorization header,
 *   and the access token only lives in memory (never in cookies/localStorage).
 * - On every (re)connect we first call /auth/me through the normal axios client. If the access token
 *   expired, the axios interceptor silently refreshes it, so the stream always starts with a valid token.
 * - Events carry no data, only "something changed". Pages re-fetch through the normal API.
 *
 * Events: 'invoice:created', 'invoice:paid', and 'resync' (fired after a RE-connect so pages can catch up
 * on anything they missed while offline).
 */
type Listener = (event: string) => void;

const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let hasConnectedBefore = false;

function dispatch(event: string) {
  listeners.forEach((l) => {
    try {
      l(event);
    } catch {
      /* one broken listener must not stop the others */
    }
  });
}

function parseBlock(block: string): string | null {
  // Only blocks with an "event:" line are real events; heartbeats (": ping") and "retry:" lines are ignored.
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) return line.slice(6).trim();
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

async function run(signal: AbortSignal) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      await api.get('/auth/me'); // refreshes the access token first if it has expired
      const token = getAccessToken();
      if (!token) throw new Error('not signed in');

      const res = await fetch(`${api.defaults.baseURL}/realtime/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);

      delay = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const name = parseBlock(block);
          if (name === 'ready') {
            if (hasConnectedBefore) dispatch('resync');
            hasConnectedBefore = true;
          } else if (name) {
            dispatch(name);
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 15000); // back off so a down server is not hammered
  }
}

function start() {
  if (controller) return;
  controller = new AbortController();
  void run(controller.signal);
}

function stopIfIdle() {
  if (listeners.size === 0 && controller) {
    controller.abort();
    controller = null;
    hasConnectedBefore = false;
  }
}

/** Calls `handler(eventName)` whenever the server pushes an event, while the component is mounted. */
export function useRealtime(handler: (event: string) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener: Listener = (event) => handlerRef.current(event);
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
      stopIfIdle();
    };
  }, []);
}