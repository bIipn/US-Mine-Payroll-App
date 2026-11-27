/**
 * For tests only: the app never imports it. A browser's lock manager (navigator.locks), made up for tests of what its
 * tabs share (recordsTab.test.ts, storage.test.ts). It hands each lock, by name, to one request at a time, as the Web
 * Locks API does with an exclusive lock: a request waits in turn; one with `ifAvailable` is answered with no lock
 * when it is held or asked for; one with `steal` takes it at once, and the request that held it ends with an
 * AbortError, though its callback goes on; one whose `signal` is aborted while it waits ends with the signal's
 * reason. A lock is let go of when its callback's promise settles, or when its tab closes. Each tab asks through a
 * client of its own (`client`).
 */
interface Waiting {
  tab: string;
  name: string;
  callback: (lock: Lock | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Set once the request has ended: it is answered no more. */
  ended: boolean;
}

const abortError = () => new DOMException('The lock was stolen by another request.', 'AbortError');

export class FakeLocks {
  private held = new Map<string, Waiting>();
  private queue = new Map<string, Waiting[]>();
  /** Tabs that are closed: nothing of theirs is answered or granted. */
  private closed = new Set<string>();
  /** Requests that are never answered (a lock manager that hangs). */
  hangs = false;

  /** The navigator.locks of one tab. */
  client(tab: string): Pick<LockManager, 'request'> {
    const request = (name: string, ...args: unknown[]): Promise<unknown> => {
      const callback = args[args.length - 1] as (lock: Lock | null) => unknown;
      const options = (args.length > 1 ? args[0] : {}) as LockOptions;
      return this.request(tab, name, options, callback);
    };
    return { request } as Pick<LockManager, 'request'>;
  }

  /** Which tab holds the lock of this name, if any. */
  holder(name: string): string | null {
    return this.held.get(name)?.tab ?? null;
  }

  /** The tab closes: the locks it holds are let go of, and what it was waiting for is not given to it. */
  close(tab: string): void {
    this.closed.add(tab);
    for (const [name, req] of [...this.held]) {
      if (req.tab !== tab) continue;
      req.ended = true;
      this.held.delete(name);
      this.next(name);
    }
    for (const [name, waiting] of this.queue) {
      this.queue.set(
        name,
        waiting.filter((req) => req.tab !== tab),
      );
      this.next(name);
    }
  }

  private request(tab: string, name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    if (this.hangs) return new Promise(() => undefined);
    if (options.mode && options.mode !== 'exclusive') return Promise.reject(new DOMException('Only exclusive locks here.', 'NotSupportedError'));
    if (options.steal && options.ifAvailable) return Promise.reject(new DOMException('steal and ifAvailable', 'NotSupportedError'));
    if (options.signal && (options.steal || options.ifAvailable)) return Promise.reject(new DOMException('signal with steal or ifAvailable', 'NotSupportedError'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise((resolve, reject) => {
      const req: Waiting = { tab, name, callback, resolve, reject, ended: false };
      if (options.steal) {
        const holder = this.held.get(name);
        if (holder) {
          holder.ended = true;
          this.held.delete(name);
          holder.reject(abortError());
        }
        this.grant(req);
        return;
      }
      const waiting = this.queue.get(name) ?? [];
      if (options.ifAvailable && (this.held.has(name) || waiting.length > 0)) {
        req.ended = true;
        setTimeout(() => {
          Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
        }, 0);
        return;
      }
      options.signal?.addEventListener('abort', () => {
        const now = this.queue.get(name) ?? [];
        if (!now.includes(req)) return;
        this.queue.set(
          name,
          now.filter((other) => other !== req),
        );
        req.ended = true;
        reject(options.signal!.reason);
      });
      this.queue.set(name, [...waiting, req]);
      this.next(name);
    });
  }

  /** Grant the lock to the first request waiting for it, if nobody holds it. */
  private next(name: string): void {
    if (this.held.has(name)) return;
    const waiting = this.queue.get(name) ?? [];
    const first = waiting.shift();
    if (!first) return;
    this.grant(first);
  }

  private grant(req: Waiting): void {
    if (this.closed.has(req.tab)) return;
    this.held.set(req.name, req);
    // The browser calls the callback in a task of its own, as a real one does.
    setTimeout(() => {
      if (req.ended) return;
      Promise.resolve()
        .then(() => req.callback({ name: req.name, mode: 'exclusive' } as Lock))
        .then(
          (value) => this.done(req, () => req.resolve(value)),
          (error) => this.done(req, () => req.reject(error)),
        );
    }, 0);
  }

  /** The callback of a request has settled: its lock is let go of, unless it was taken from it already. */
  private done(req: Waiting, settle: () => void): void {
    if (req.ended) return;
    req.ended = true;
    if (this.held.get(req.name) === req) {
      this.held.delete(req.name);
      this.next(req.name);
    }
    settle();
  }
}
