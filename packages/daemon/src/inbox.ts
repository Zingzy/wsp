import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
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

  constructor(opts: InboxOptions) {
    super();
    this.dir = opts.dir;
    this.quietMs = opts.quietMs ?? 2000;
    this.pollMs = opts.pollMs ?? 250;
  }

  start(): void {
    if (this.watcher) return;
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
  }

  private track(path: string): void {
    if (!this.pending.has(path)) this.pending.set(path, { size: -1, stableSince: Date.now() });
  }

  private async sweep(): Promise<void> {
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
