export function createWsFrameGate<T>() {
  let handler: ((frame: T) => Promise<void> | void) | null = null;
  let pending: T[] = [];
  let chain = Promise.resolve();

  const dispatch = (frame: T): void => {
    if (!handler) {
      pending.push(frame);
      return;
    }
    chain = chain.then(() => handler!(frame));
  };

  return {
    dispatch,
    open(next: (frame: T) => Promise<void> | void): void {
      if (handler) throw new Error("WebSocket frame gate already opened");
      handler = next;
      const queued = pending;
      pending = [];
      for (const frame of queued) dispatch(frame);
    },
    drained(): Promise<void> {
      return chain;
    },
  };
}
