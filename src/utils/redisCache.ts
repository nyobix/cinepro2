import { Redis } from 'ioredis';

/**
 * Represents a cached stream link entry stored in Redis.
 */
export interface CachedStreamLink {
    url: string;
    provider: string;
    quality: string;
    headers?: Record<string, string>;
    cachedAt: number;
    expiresAt: number;
}

/** 7-day TTL in seconds */
const STREAM_LINK_TTL = 7 * 24 * 60 * 60;
const CACHE_PREFIX = 'cinepro:stream:';

let redisClient: Redis | null = null;

/**
 * Get (or lazily create) the shared Redis client.
 * Connection parameters are read from environment variables:
 *   REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 */
function getRedisClient(): Redis {
    if (redisClient) {
        return redisClient;
    }

    redisClient = new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
        db: 0,
        retryStrategy: (times: number): number => {
            return Math.min(times * 50, 2000);
        },
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
    });

    redisClient.on('connect', (): void => {
        console.info('[redisCache] Redis connected');
    });

    redisClient.on('error', (error: Error): void => {
        console.error(`[redisCache] Redis error: ${error.message}`);
    });

    redisClient.on('reconnecting', (): void => {
        console.warn('[redisCache] Redis reconnecting...');
    });

    return redisClient;
}

/**
 * Build the Redis key for a given media ID and provider.
 */
function buildKey(mediaId: string, provider: string): string {
    return `${CACHE_PREFIX}${mediaId}:${provider.toLowerCase()}`;
}

/**
 * Retrieve a cached stream link.
 * Returns `null` on cache miss, parse error, or expiry.
 */
export async function getCachedStreamLink(
    mediaId: string,
    provider: string
): Promise<CachedStreamLink | null> {
    try {
        const redis = getRedisClient();
        const key = buildKey(mediaId, provider);
        const raw = await redis.get(key);

        if (!raw) {
            return null;
        }

        let data: CachedStreamLink;
        try {
            data = JSON.parse(raw) as CachedStreamLink;
        } catch {
            // Corrupted entry — remove it
            await redis.del(key);
            return null;
        }

        if (data.expiresAt < Date.now()) {
            await redis.del(key);
            return null;
        }

        return data;
    } catch (error) {
        console.error(
            `[redisCache] getCachedStreamLink error: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

/**
 * Store a stream link in Redis with a 7-day TTL.
 * Returns `true` on success, `false` on failure.
 */
export async function setCachedStreamLink(
    mediaId: string,
    provider: string,
    link: Omit<CachedStreamLink, 'cachedAt' | 'expiresAt'>
): Promise<boolean> {
    try {
        const redis = getRedisClient();
        const key = buildKey(mediaId, provider);
        const now = Date.now();

        const entry: CachedStreamLink = {
            ...link,
            cachedAt: now,
            expiresAt: now + STREAM_LINK_TTL * 1000,
        };

        await redis.setex(key, STREAM_LINK_TTL, JSON.stringify(entry));
        return true;
    } catch (error) {
        console.error(
            `[redisCache] setCachedStreamLink error: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
    }
}

/**
 * Delete a cached stream link entry.
 * Returns `true` if a key was deleted, `false` otherwise.
 */
export async function deleteCachedStreamLink(
    mediaId: string,
    provider: string
): Promise<boolean> {
    try {
        const redis = getRedisClient();
        const key = buildKey(mediaId, provider);
        const deleted = await redis.del(key);
        return deleted > 0;
    } catch (error) {
        console.error(
            `[redisCache] deleteCachedStreamLink error: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
    }
}

/**
 * Gracefully close the Redis connection.
 */
export async function disconnectRedis(): Promise<void> {
    if (!redisClient) {
        return;
    }
    try {
        await redisClient.quit();
        redisClient = null;
        console.info('[redisCache] Redis disconnected');
    } catch (error) {
        console.error(
            `[redisCache] disconnect error: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
