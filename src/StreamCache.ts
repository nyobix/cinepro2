import { Redis as IORedis } from 'ioredis';

type RedisClient = InstanceType<typeof IORedis>;

export class StreamCache {
  private static redis: RedisClient | null = null;
  private static readonly THREE_DAYS = 259200; // 3 days in seconds
  private static readonly SCRAPE_LOCK_TTL = 60; // 1 minute lock

  static async init() {
    if (this.redis) {
      return;
    }

    this.redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });

    this.redis.on('connect', () => {
      console.info('Redis cache connected successfully');
    });

    this.redis.on('error', (error: Error) => {
      console.error(`Redis connection error: ${error.message}`);
    });

    this.redis.on('reconnecting', () => {
      console.warn('Redis attempting to reconnect...');
    });
  }

  private static async getClient(): Promise<any> {
    if (!this.redis) {
      await this.init();
    }

    if (!this.redis) {
      throw new Error('Redis client not initialized');
    }

    return this.redis;
  }

  static async get(mediaId: string): Promise<any | null> {
    const redis = await this.getClient();
    const cached = await redis.get(`streams:${mediaId}`);
    return cached ? JSON.parse(cached) : null;
  }

  static async set(mediaId: string, data: any, ttlSeconds: number = this.THREE_DAYS): Promise<void> {
    const redis = await this.getClient();
    await redis.setex(`streams:${mediaId}`, ttlSeconds, JSON.stringify(data));
  }

  static async del(mediaId: string): Promise<void> {
    const redis = await this.getClient();
    await redis.del(`streams:${mediaId}`);
  }

  static async acquireScrapeLock(mediaId: string): Promise<boolean> {
    const redis = await this.getClient();
    const lockKey = `lock:scrape:${mediaId}`;
    const result = await redis.set(lockKey, 'locked', 'EX', this.SCRAPE_LOCK_TTL, 'NX');
    return result === 'OK';
  }

  static async releaseScrapeLock(mediaId: string): Promise<void> {
    const redis = await this.getClient();
    await redis.del(`lock:scrape:${mediaId}`);
  }

  static async isScrapeInProgress(mediaId: string): Promise<boolean> {
    const redis = await this.getClient();
    return !!(await redis.get(`lock:scrape:${mediaId}`));
  }
}
