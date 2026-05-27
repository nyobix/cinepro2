/**
 * Redis cache utility for stream links with 7-day TTL
 */

import Redis from 'ioredis';

interface RedisCacheOptions {
    host: string;
    port: number;
    password?: string;
    ttl?: number; // in seconds
}

interface CachedStreamLink {
    url: string;
    headers?: Record<string, string>;
    type: 'mp4' | 'hls';
    timestamp: number;
}

export class RedisStreamCache {
    private redis: Redis;
    private ttl: number; // in seconds
    private readonly CACHE_PREFIX = 'stream:';
    private readonly STREAM_LINKS_PREFIX = 'stream_links:';

    constructor(options: RedisCacheOptions) {
        this.ttl = options.ttl ?? 7 * 24 * 60 * 60; // 7 days default

        this.redis = new Redis({
            host: options.host,
            port: options.port,
            password: options.password,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3
        });

        this.redis.on('error', (err) => {
            console.error('Redis connection error:', err);
        });

        this.redis.on('connect', () => {
            console.log('Redis cache connected');
        });
    }

    /**
     * Generate cache key for a stream link
     */
    private generateKey(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        season?: number,
        episode?: number
    ): string {
        if (mediaType === 'movie') {
            return `${this.STREAM_LINKS_PREFIX}${providerId}:movie:${tmdbId}`;
        }
        return `${this.STREAM_LINKS_PREFIX}${providerId}:tv:${tmdbId}:s${season}e${episode}`;
    }

    /**
     * Get cached stream link
     */
    async getStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        season?: number,
        episode?: number
    ): Promise<CachedStreamLink | null> {
        try {
            const key = this.generateKey(providerId, mediaType, tmdbId, season, episode);
            const cached = await this.redis.get(key);

            if (!cached) {
                return null;
            }

            const data = JSON.parse(cached) as CachedStreamLink;
            
            // Verify cache is still valid (not expired)
            const age = Date.now() - data.timestamp;
            if (age > this.ttl * 1000) {
                await this.redis.del(key);
                return null;
            }

            return data;
        } catch (error) {
            console.error('Error retrieving from cache:', error);
            return null;
        }
    }

    /**
     * Cache a stream link with 7-day TTL
     */
    async setStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        link: CachedStreamLink,
        season?: number,
        episode?: number
    ): Promise<void> {
        try {
            const key = this.generateKey(providerId, mediaType, tmdbId, season, episode);
            const data: CachedStreamLink = {
                ...link,
                timestamp: Date.now()
            };

            await this.redis.setex(
                key,
                this.ttl,
                JSON.stringify(data)
            );
        } catch (error) {
            console.error('Error setting cache:', error);
            // Don't throw - cache failures shouldn't break the app
        }
    }

    /**
     * Invalidate a cached stream link
     */
    async invalidateStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        season?: number,
        episode?: number
    ): Promise<void> {
        try {
            const key = this.generateKey(providerId, mediaType, tmdbId, season, episode);
            await this.redis.del(key);
        } catch (error) {
            console.error('Error invalidating cache:', error);
        }
    }

    /**
     * Clear all stream link cache
     */
    async clearAllStreamLinks(): Promise<void> {
        try {
            const keys = await this.redis.keys(`${this.STREAM_LINKS_PREFIX}*`);
            if (keys.length > 0) {
                await this.redis.del(...keys);
            }
        } catch (error) {
            console.error('Error clearing cache:', error);
        }
    }

    /**
     * Get cache statistics
     */
    async getStats(): Promise<{
        totalKeys: number;
        ttl: number;
        connected: boolean;
    }> {
        try {
            const keys = await this.redis.keys(`${this.STREAM_LINKS_PREFIX}*`);
            return {
                totalKeys: keys.length,
                ttl: this.ttl,
                connected: this.redis.status === 'ready'
            };
        } catch (error) {
            console.error('Error getting cache stats:', error);
            return {
                totalKeys: 0,
                ttl: this.ttl,
                connected: false
            };
        }
    }

    /**
     * Close Redis connection
     */
    async disconnect(): Promise<void> {
        await this.redis.quit();
    }
}

/**
 * Create a singleton Redis cache instance
 */
let redisCache: RedisStreamCache | null = null;

export function getRedisCache(): RedisStreamCache {
    if (!redisCache) {
        redisCache = new RedisStreamCache({
            host: process.env.REDIS_HOST || 'localhost',
            port: Number(process.env.REDIS_PORT || 6379),
            password: process.env.REDIS_PASSWORD,
            ttl: 7 * 24 * 60 * 60 // 7 days
        });
    }
    return redisCache;
}

