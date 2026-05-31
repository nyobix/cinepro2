import Redis from 'ioredis';

const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on('error', (err) => console.error('[Redis] Connection Error:', err));
redis.on('connect', () => console.log('[Redis] Connected successfully'));

export const STREAM_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Standardized interface for stream links
 */
export interface CachedStream {
    url: string;
    quality?: string;
    headers?: Record<string, string>;
    providerId: string;
}

/**
 * Retrieves cached streams for a specific media ID and provider.
 */
export async function getCachedStreams(mediaId: string, providerId: string): Promise<CachedStream[] | null> {
    try {
        const key = `stream:${providerId}:${mediaId}`;
        const data = await redis.get(key);
        return data ? (JSON.parse(data) as CachedStream[]) : null;
    } catch (err) {
        console.error('[Redis] Get error:', err);
        return null;
    }
}

/**
 * Caches streams with a 7-day expiration.
 */
export async function setCachedStreams(mediaId: string, providerId: string, streams: CachedStream[]): Promise<void> {
    try {
        const key = `stream:${providerId}:${mediaId}`;
        await redis.setex(key, STREAM_CACHE_TTL, JSON.stringify(streams));
        console.log(`[Redis] Cached ${streams.length} links for ${mediaId} via ${providerId}`);
    } catch (err) {
        console.error('[Redis] Set error:', err);
    }
}