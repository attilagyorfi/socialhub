import { Redis } from "ioredis";
import { Queue } from "bullmq";
let connection: Redis | undefined;
export function redis() {
  return (connection ??= new Redis(
    process.env.REDIS_URL ?? "redis://localhost:6379",
    { maxRetriesPerRequest: null, lazyConnect: true },
  ));
}
let jobs: Queue | undefined;
export function publishQueue() {
  return (jobs ??= new Queue("g2a-publish", {
    connection: redis(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  }));
}
let mediaJobs: Queue | undefined;
export function mediaQueue() {
  return (mediaJobs ??= new Queue("g2a-media", {
    connection: redis(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  }));
}
export async function rateLimit(key: string, max = 60, windowSeconds = 60) {
  const count = Number(
    await redis().eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      `rate:${key}`,
      windowSeconds,
    ),
  );
  return count <= max;
}
// Like rateLimit, but the same atomic script also returns the window's
// remaining seconds for a Retry-After header. With consume=false it only
// reports whether one more hit would still fit, without counting one.
export async function rateLimitWithRetry(
  key: string,
  max = 60,
  windowSeconds = 60,
  consume = true,
) {
  const [count, ttl] = (
    (await redis().eval(
      "local n; if ARGV[2]=='1' then n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end else n=tonumber(redis.call('GET',KEYS[1]) or '0') end; local t=redis.call('TTL',KEYS[1]); if t==-1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); t=tonumber(ARGV[1]) end; return {n,t}",
      1,
      `rate:${key}`,
      windowSeconds,
      consume ? "1" : "0",
    )) as [number, number]
  ).map(Number);
  return {
    allowed: consume ? count <= max : count < max,
    retryAfter: ttl > 0 ? Math.ceil(ttl) : windowSeconds,
  };
}
