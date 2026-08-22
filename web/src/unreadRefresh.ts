export type UnreadValues = Record<string, number>;

export interface UnreadRefresh {
  request(): Promise<void>;
  dispose(): void;
}

export function parseUnreadValues(value: unknown): UnreadValues | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed: UnreadValues = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    if (count > 0) parsed[key] = count;
  }
  return parsed;
}

export function createUnreadRefresh(load: () => Promise<unknown>, commit: (values: UnreadValues) => void): UnreadRefresh {
  let active = true;
  let requested = 0;
  let completed = 0;
  let running = false;
  let waiters: Array<{ target: number; resolve: () => void }> = [];

  const settleWaiters = () => {
    const pending: typeof waiters = [];
    for (const waiter of waiters) {
      if (!active || waiter.target <= completed) waiter.resolve();
      else pending.push(waiter);
    }
    waiters = pending;
  };

  const drain = async () => {
    try {
      while (active && completed < requested) {
        const target = requested;
        try {
          const values = parseUnreadValues(await load());
          if (active && values) commit(values);
        } catch { /* keep the current badge map */ }
        completed = target;
        settleWaiters();
      }
    } finally {
      running = false;
      if (active && completed < requested) start();
    }
  };

  const start = () => {
    if (running || !active) return;
    running = true;
    void drain();
  };

  return {
    request() {
      if (!active) return Promise.resolve();
      const target = ++requested;
      const done = new Promise<void>((resolve) => waiters.push({ target, resolve }));
      start();
      return done;
    },
    dispose() {
      active = false;
      settleWaiters();
    },
  };
}
