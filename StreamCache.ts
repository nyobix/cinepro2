import Redis from 'ioredis';

export class StreamCache {
  private static redis: Redis;
  private static readonly THREE_DAYS = 259200; // 3 days in seconds
  private static readonly SCRAPE_LOCK_TTL = 60; // 1 minute lock

  static async init() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD
    });
    console.log('✅ Redis initialized for 3-day TTL caching');
  }

  static async get(mediaId: string): Promise<any | null> {
    const cached = await this.redis.get(`streams:${mediaId}`);
    return cached ? JSON.parse(cached) : null;
  }

  static async set(mediaId: string, data: any): Promise<void> {
    await this.redis.setex(`streams:${mediaId}`, this.THREE_DAYS, JSON.stringify(data));
  }

  static async del(mediaId: string): Promise<void> {
    await this.redis.del(`streams:${mediaId}`);
  }

  /**
   * Atomic lock to prevent multiple concurrent scrapes for the same media.
   * Returns true if this request "won" the right to scrape.
   */
  static async acquireScrapeLock(mediaId: string): Promise<boolean> {
    const lockKey = `lock:scrape:${mediaId}`;
    // NX = Only set if it doesn't exist. EX = Set expiration.
    const result = await this.redis.set(lockKey, 'locked', 'EX', this.SCRAPE_LOCK_TTL, 'NX');
    return result === 'OK';
  }

  static async releaseScrapeLock(mediaId: string): Promise<void> {
    await this.redis.del(`lock:scrape:${mediaId}`);
  }

  static async isScrapeInProgress(mediaId: string): Promise<boolean> {
    return !!(await this.redis.get(`lock:scrape:${mediaId}`));
  }
}