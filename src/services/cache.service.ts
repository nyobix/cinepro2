import { Redis } from 'ioredis';

export interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  ttl?: number;
}

export interface StreamLinkCache {
  url: string;
  provider: string;
  quality: string;
  expiresAt: number;
  cachedAt: number;
}

/**
 * Redis Cache Service
 * Manages caching of resolved stream links with 7-day TTL
 */
export class CacheService {
  private redis: Redis;
  private readonly STREAM_LINK_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
  private readonly CACHE_PREFIX = 'cinepro:stream:';
  private readonly METADATA_PREFIX = 'cinepro:meta:';

  constructor(config: CacheConfig) {
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
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

  /**
   * Generate cache key for a media item
   */
  private generateCacheKey(mediaId: string, provider: string): string {
    return `${this.CACHE_PREFIX}${mediaId}:${provider.toLowerCase()}`;
  }

  /**
   * Generate metadata key for tracking cache statistics
   */
  private generateMetadataKey(mediaId: string): string {
    return `${this.METADATA_PREFIX}${mediaId}`;
  }

  /**
   * Get cached stream link
   * Returns null if not found or expired
   */
  async getStreamLink(
    mediaId: string,
    provider: string
  ): Promise<StreamLinkCache | null> {
    try {
      const key = this.generateCacheKey(mediaId, provider);
      const cached = await this.redis.get(key);

      if (!cached) {
        console.debug(`Cache MISS for ${mediaId}:${provider}`);
        return null;
      }

      const data = JSON.parse(cached) as StreamLinkCache;

      // Validate expiration
      if (data.expiresAt < Date.now()) {
        console.debug(`Cache EXPIRED for ${mediaId}:${provider}`);
        await this.redis.del(key);
        return null;
      }

      // Update access time metadata
      await this.incrementCacheHit(mediaId);

      console.debug(`Cache HIT for ${mediaId}:${provider}`);
      return data;
    } catch (error) {
      console.error(
        `Error retrieving cached stream link: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Cache a resolved stream link with 7-day TTL
   */
  async setStreamLink(
    mediaId: string,
    provider: string,
    linkData: Omit<StreamLinkCache, 'expiresAt' | 'cachedAt'>
  ): Promise<boolean> {
    try {
      const key = this.generateCacheKey(mediaId, provider);
      const now = Date.now();

      const cacheData: StreamLinkCache = {
        ...linkData,
        cachedAt: now,
        expiresAt: now + this.STREAM_LINK_TTL * 1000, // Convert to milliseconds
      };

      // Set with TTL in Redis
      await this.redis.setex(
        key,
        this.STREAM_LINK_TTL,
        JSON.stringify(cacheData)
      );

      // Track metadata
      await this.incrementCacheMiss(mediaId);

      console.debug(
        `Cached stream link for ${mediaId}:${provider} (TTL: 7 days)`
      );
      return true;
    } catch (error) {
      console.error(
        `Error caching stream link: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Get all cached stream links for a media item
   */
  async getAllStreamLinks(mediaId: string): Promise<StreamLinkCache[]> {
    try {
      const pattern = this.generateCacheKey(mediaId, '*');
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        return [];
      }

      const links: StreamLinkCache[] = [];

      for (const key of keys) {
        const cached = await this.redis.get(key);
        if (cached) {
          const data = JSON.parse(cached) as StreamLinkCache;
          if (data.expiresAt >= Date.now()) {
            links.push(data);
          } else {
            await this.redis.del(key);
          }
        }
      }

      return links;
    } catch (error) {
      console.error(
        `Error retrieving all cached stream links: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * Invalidate cache for a specific stream link
   */
  async invalidateStreamLink(mediaId: string, provider: string): Promise<boolean> {
    try {
      const key = this.generateCacheKey(mediaId, provider);
      const deleted = await this.redis.del(key);
      console.debug(`Invalidated cache for ${mediaId}:${provider}`);
      return deleted > 0;
    } catch (error) {
      console.error(
        `Error invalidating cache: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Clear all cache for a media item
   */
  async invalidateMedia(mediaId: string): Promise<boolean> {
    try {
      const pattern = this.generateCacheKey(mediaId, '*');
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        return true;
      }

      await this.redis.del(...keys);
      console.debug(`Cleared all cache for media ${mediaId}`);
      return true;
    } catch (error) {
      console.error(
        `Error clearing media cache: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Increment cache hit counter for analytics
   */
  private async incrementCacheHit(mediaId: string): Promise<void> {
    try {
      const key = this.generateMetadataKey(mediaId);
      await this.redis.hincrby(key, 'hits', 1);
      await this.redis.expire(key, this.STREAM_LINK_TTL);
    } catch (error) {
      console.warn(
        `Error incrementing cache hit: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Increment cache miss counter for analytics
   */
  private async incrementCacheMiss(mediaId: string): Promise<void> {
    try {
      const key = this.generateMetadataKey(mediaId);
      await this.redis.hincrby(key, 'misses', 1);
      await this.redis.expire(key, this.STREAM_LINK_TTL);
    } catch (error) {
      console.warn(
        `Error incrementing cache miss: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get cache statistics for a media item
   */
  async getCacheStats(mediaId: string): Promise<{ hits: number; misses: number }> {
    try {
      const key = this.generateMetadataKey(mediaId);
      const stats = await this.redis.hgetall(key);

      return {
        hits: parseInt(stats.hits || '0', 10),
        misses: parseInt(stats.misses || '0', 10),
      };
    } catch (error) {
      console.error(
        `Error retrieving cache stats: ${error instanceof Error ? error.message : String(error)}`
      );
      return { hits: 0, misses: 0 };
    }
  }

  /**
   * Get overall cache statistics
   */
  async getGlobalStats(): Promise<{
    totalKeys: number;
    memoryUsage: string;
    connectedClients: number;
  }> {
    try {
      const keys = await this.redis.keys(`${this.CACHE_PREFIX}*`);
      const info = await this.redis.info('memory');
      const clients = await this.redis.info('clients');

      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      const clientsMatch = clients.match(/connected_clients:(\d+)/);

      return {
        totalKeys: keys.length,
        memoryUsage: memoryMatch ? memoryMatch[1] : 'unknown',
        connectedClients: clientsMatch ? parseInt(clientsMatch[1], 10) : 0,
      };
    } catch (error) {
      console.error(
        `Error retrieving global stats: ${error instanceof Error ? error.message : String(error)}`
      );
      return { totalKeys: 0, memoryUsage: 'unknown', connectedClients: 0 };
    }
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
      console.info('Redis cache disconnected');
    } catch (error) {
      console.error(
        `Error closing Redis connection: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
