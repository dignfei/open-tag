import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredAdmission {
  id: string;
  expiresAt: number;
}

const MAX_ADMISSIONS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

/** Process-independent delivery fence. Only successful runtime admissions are recorded. */
export class DeliveryAdmissionStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly entries = new Map<string, number>();
  private loadPromise: Promise<void> | null = null;
  private writeTail = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, ".delivery-admissions.json");
    this.lockFile = `${this.file}.lock`;
  }

  async has(id: string, now = Date.now()): Promise<boolean> {
    await this.load();
    // Another daemon process can overlap this one during replacement. Its successful
    // admission may have landed after our initial load, so refresh the atomic ledger
    // before deciding that an id is absent.
    await this.loadFromDisk();
    const expiresAt = this.entries.get(id);
    if (!expiresAt) return false;
    if (expiresAt > now) return true;
    this.entries.delete(id);
    return false;
  }

  async remember(id: string, expiresAt: number): Promise<void> {
    await this.load();
    this.entries.set(id, expiresAt);
    this.prune(Date.now());
    const write = this.writeTail.then(() => this.persist());
    this.writeTail = write.catch(() => {});
    await write;
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!Array.isArray(parsed)) throw new Error("delivery admission ledger must be an array");
    const now = Date.now();
    for (const item of parsed) {
      if (!item || typeof item.id !== "string" || typeof item.expiresAt !== "number" || item.expiresAt <= now) continue;
      this.entries.set(item.id, item.expiresAt);
    }
    this.prune(now);
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(id);
    if (this.entries.size <= MAX_ADMISSIONS) return;
    const oldest = [...this.entries].sort((a, b) => a[1] - b[1]).slice(0, this.entries.size - MAX_ADMISSIONS);
    for (const [id] of oldest) this.entries.delete(id);
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.withFileLock(async () => {
      const now = Date.now();
      let diskRows: unknown = [];
      try {
        diskRows = JSON.parse(await readFile(this.file, "utf8"));
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!Array.isArray(diskRows)) throw new Error("delivery admission ledger must be an array");
      for (const item of diskRows) {
        if (!item || typeof item.id !== "string" || typeof item.expiresAt !== "number" || item.expiresAt <= now) continue;
        const existing = this.entries.get(item.id) ?? 0;
        if (item.expiresAt > existing) this.entries.set(item.id, item.expiresAt);
      }
      this.prune(now);
      const rows: StoredAdmission[] = [...this.entries].map(([id, expiresAt]) => ({ id, expiresAt }));
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(rows), { mode: 0o600 });
      await rename(temp, this.file);
    });
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
          return await operation();
        } finally {
          await handle.close().catch(() => {});
          await unlink(this.lockFile).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
        }
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockFile);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await unlink(this.lockFile).catch((unlinkError: any) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
            continue;
          }
        } catch (statError: any) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error("timed out acquiring delivery admission ledger lock");
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
  }
}
