// In-memory stand-in for the ioredis client used by the rate limiters
// (packages/server/queue.ts). It runs the two limiter scripts' logic against
// a map with a controllable clock; any other command fails loudly.
export class FakeRedis {
  static store = new Map<string, { value: number; expiresAt?: number }>();
  static now = () => Date.now();
  static failing = false;

  static reset() {
    FakeRedis.store.clear();
    FakeRedis.now = () => Date.now();
    FakeRedis.failing = false;
  }

  private entry(key: string) {
    const entry = FakeRedis.store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= FakeRedis.now()) {
      FakeRedis.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private ttl(key: string) {
    const entry = this.entry(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.ceil((entry.expiresAt - FakeRedis.now()) / 1000);
  }

  async eval(
    script: string,
    _keys: number,
    key: string,
    windowSeconds: number | string,
    consume?: string,
  ) {
    if (FakeRedis.failing) throw new Error("Connection is closed.");
    const window = Number(windowSeconds) * 1000;
    const increment = !script.includes("ARGV[2]") || consume === "1";
    let count = this.entry(key)?.value ?? 0;
    if (increment) {
      count += 1;
      const current = this.entry(key);
      FakeRedis.store.set(key, {
        value: count,
        expiresAt: count === 1 ? FakeRedis.now() + window : current?.expiresAt,
      });
    }
    if (!script.includes("TTL")) return count;
    return [count, this.ttl(key)];
  }
}
