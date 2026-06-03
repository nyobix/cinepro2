import { Redis } from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

export let redis: Redis | null = null;

if (process.env.CACHE_TYPE === 'redis') {
    redis = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });

    redis.on('error', (err: Error) => {
        console.error('[Redis] Error:', err);
    });
}

const STREAM_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export interface CachedStream {
    url: string;
    quality?: string;
    source: string;
    headers?: Record<string, string>;
}

export async function getCachedStreams(mediaId: string, providerId: string): Promise<CachedStream[] | null> {
    if (!redis) return null;
    try {
        const key = `streams:${providerId}:${mediaId}`;
        const data = await redis.get(key);
        return data ? (JSON.parse(data) as CachedStream[]) : null;
    } catch (err) {
        console.error('[Redis] Get error:', err);
        return null;
    }
}

export async function setCachedStreams(mediaId: string, providerId: string, streams: CachedStream[]): Promise<void> {
    if (!redis) return;
    try {
        const key = `streams:${providerId}:${mediaId}`;
        await redis.set(key, JSON.stringify(streams), 'EX', STREAM_CACHE_TTL);
    } catch (err) {
        console.error('[Redis] Set error:', err);
    }
}

export async function invalidateCache(mediaId: string, providerId: string): Promise<void> {
    if (!redis) return;
    try {
        const key = `streams:${providerId}:${mediaId}`;
        await redis.del(key);
    } catch (err) {
        console.error('[Redis] Invalidate error:', err);
    }
}