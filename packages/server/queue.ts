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
