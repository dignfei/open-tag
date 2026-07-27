// A short transport timeout drives deterministic same-id retries. The daemon shares the
// original admission Promise, so slow cold starts and lost ACKs do not execute work twice.
const ACK_TIMEOUT_MS = Number(process.env.OPEN_TAG_AGENT_DELIVERY_ACK_MS ?? 2_000);

interface PendingAck {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  subscribers: number;
}

const pending = new Map<string, PendingAck>();

function armTimeout(deliveryId: string, entry: PendingAck): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (pending.get(deliveryId) !== entry) return;
    forget(deliveryId, entry);
    entry.reject(new Error(`agent delivery ACK timeout: ${deliveryId}`));
  }, ACK_TIMEOUT_MS);
}

export function expectAgentDeliveryAck(deliveryId: string, _agentId: string, _seq: number): { promise: Promise<void>; cancel: () => void } {
  let entry = pending.get(deliveryId);
  if (!entry) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    entry = {
      promise, resolve, reject, subscribers: 0,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.set(deliveryId, entry);
    armTimeout(deliveryId, entry);
  }

  entry.subscribers++;
  let cancelled = false;
  return {
    promise: entry.promise,
    cancel: () => {
      if (cancelled || pending.get(deliveryId) !== entry) return;
      cancelled = true;
      entry.subscribers--;
      if (entry.subscribers === 0) forget(deliveryId, entry);
    },
  };
}

/** The connected daemon still owns this delivery while its runtime input queue is busy. */
export function noteAgentDeliveryPending(deliveryId: string | undefined): boolean {
  if (!deliveryId) return false;
  const entry = pending.get(deliveryId);
  if (!entry) return false;
  armTimeout(deliveryId, entry);
  return true;
}

export function hasPendingAgentDelivery(deliveryId: string | undefined): boolean {
  return !!deliveryId && pending.has(deliveryId);
}

function forget(deliveryId: string, entry: PendingAck): void {
  clearTimeout(entry.timer);
  if (pending.get(deliveryId) === entry) pending.delete(deliveryId);
}

export function acceptAgentDeliveryAck(deliveryId: string | undefined, _agentId?: string, _seq?: number): boolean {
  if (!deliveryId) return false;
  const entry = pending.get(deliveryId);
  if (!entry) return false;
  forget(deliveryId, entry);
  entry.resolve();
  return true;
}

export function rejectAgentDeliveryAck(deliveryId: string | undefined, _agentId?: string, _seq?: number, detail?: string): boolean {
  if (!deliveryId) return false;
  const entry = pending.get(deliveryId);
  if (!entry) return false;
  forget(deliveryId, entry);
  entry.reject(new Error(`agent delivery NACK: ${deliveryId}${detail ? `: ${detail}` : ""}`));
  return true;
}
