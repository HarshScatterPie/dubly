// A FIFO counting semaphore: at most `capacity` holders at once, later callers wait their turn (or give up after `timeoutMs`).
export class Semaphore {
  private active = 0;
  private waiters: { grant: () => void; timer?: NodeJS.Timeout }[] = [];

  constructor(private capacity: number) {}

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  // Resolves with a release function once a slot is free; rejects with SemaphoreTimeoutError if none frees up in time.
  acquire(timeoutMs?: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.next();
        });
      };
      if (this.active < this.capacity && this.waiters.length === 0) {
        grant();
        return;
      }
      const waiter: { grant: () => void; timer?: NodeJS.Timeout } = { grant };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new SemaphoreTimeoutError());
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private next(): void {
    while (this.active < this.capacity && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.grant();
    }
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for a free processing slot');
  }
}
