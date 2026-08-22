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
  let running: Promise<void> | null = null;

  const drain = async () => {
    while (active && completed < requested) {
      const target = requested;
      try {
        const values = parseUnreadValues(await load());
        if (active && values && target === requested) commit(values);
      } catch { /* keep the current badge map */ }
      completed = target;
    }
  };

  const waitFor = async (target: number) => {
    while (active && completed < target) {
      if (!running) running = drain().finally(() => { running = null; });
      await running;
    }
  };

  return {
    request() {
      if (!active) return Promise.resolve();
      const target = ++requested;
      return waitFor(target);
    },
    dispose() {
      active = false;
    },
  };
}
