import { EventEmitter } from "node:events";
import { readdirSync, watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface InboxFileEvent {
  type: "inbox.file";
  path: string;
  bytes: number;
}

export interface InboxOptions {
  dir: string;
  /** How long a file's size must hold still before it counts as fully uploaded. */
  quietMs?: number;
  pollMs?: number;
}

interface Pending {
  size: number;
  stableSince: number;
}

export class InboxWatcher extends EventEmitter {
  readonly dir: string;
  private quietMs: number;
  private pollMs: number;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private sweeping = false;

  constructor(opts: InboxOptions) {
    super();
    this.dir = opts.dir;
    this.quietMs = opts.quietMs ?? 2000;
    this.pollMs = opts.pollMs ?? 250;
  }

  start(): void {
    if (this.watcher) return;
    // Files present at start are rescan's to report; seeded before fs.watch so every later drop is unseen.
    for (const name of readdirSync(this.dir)) this.seen.add(join(this.dir, name));
    this.watcher = watch(this.dir, (_event, filename) => {
      if (filename) this.track(join(this.dir, String(filename)));
    });
    this.timer = setInterval(() => void this.sweep(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.seen.clear();
  }

  /** List the settled files currently in the inbox, for clients recovering missed events. */
  async rescan(): Promise<InboxFileEvent[]> {
    const names = await readdir(this.dir);
    const out: InboxFileEvent[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      if (this.pending.has(path)) continue; // mid-upload: the settle sweep will announce it
      let size: number;
      try {
        const s = await stat(path);
        if (!s.isFile()) continue;
        size = s.size;
      } catch {
        continue; // vanished between readdir and stat
      }
      out.push({ type: "inbox.file", path, bytes: size });
    }
    return out;
  }

  private track(path: string): void {
    this.seen.add(path);
    if (!this.pending.has(path)) this.pending.set(path, { size: -1, stableSince: Date.now() });
  }

  /** fs.watch can drop events (FSEvents startup window, inotify overflow), so the sweep is the guarantee. */
  private async trackUnseen(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const present = new Set(names.map(name => join(this.dir, name)));
    for (const path of this.seen) if (!present.has(path)) this.seen.delete(path);
    for (const path of present) if (!this.seen.has(path)) this.track(path);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.settle();
    } finally {
      this.sweeping = false;
    }
  }

  private async settle(): Promise<void> {
    await this.trackUnseen();
    const now = Date.now();
    for (const [path, p] of this.pending) {
      let size: number;
      try {
        const s = await stat(path);
        if (!s.isFile()) {
          this.pending.delete(path);
          continue;
        }
        size = s.size;
      } catch {
        this.pending.delete(path); // vanished mid-upload
        continue;
      }
      if (size !== p.size) {
        this.pending.set(path, { size, stableSince: now });
        continue;
      }
      if (now - p.stableSince >= this.quietMs) {
        this.pending.delete(path);
        this.emit("inbox.file", { type: "inbox.file", path, bytes: size } satisfies InboxFileEvent);
      }
    }
  }
}
