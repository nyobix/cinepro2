import { getCachedStreams, setCachedStreams, redis, type CachedStream } from './redisCache.js';

/**
 * Helper to handle the cache-first scraping logic.
 * Implements Cache-Aside pattern with DB as source of truth 
 * and Redis lock for Cache Stampede Protection.
 */
export async function resolveWithCache(
    mediaId: string,
    providerId: string,
    scraperTask: () => Promise<CachedStream[]>,
    dbCheck?: (mediaId: string, providerId: string) => Promise<CachedStream[] | null>,
    dbSave?: (mediaId: string, providerId: string, streams: CachedStream[]) => Promise<void>
): Promise<CachedStream[]> {
    // 1. Scenario A: Absolute Cache HIT (Redis)
    const cached = await getCachedStreams(mediaId, providerId);
    if (cached && cached.length > 0) {
        console.log(`[Redis Hit] Serving ${cached.length} links for ${mediaId}`);
        return cached;
    }

    // 2. Scenario B: Tier-2 Cache HIT (Supabase/Database)
    if (dbCheck) {
        const dbCached = await dbCheck(mediaId, providerId);
        if (dbCached && dbCached.length > 0) {
            console.log(`[DB Hit] Re-warming Redis for ${mediaId}`);
            // Re-warm Redis asynchronously to keep this request fast
            setCachedStreams(mediaId, providerId, dbCached).catch(err => 
                console.error('[Redis Re-warm Error]:', err)
            );
            return dbCached;
        }
    }

    // 3. Scenario C: Ultimate Cache MISS & Stampede Protection
    const lockKey = `lock:${providerId}:${mediaId}`;
    if (!redis) return await scraperTask();

    // Acquire distributed lock (SET NX EX)
    const acquired = await redis.set(lockKey, 'locked', 'EX', 15, 'NX');
    
    if (acquired !== 'OK') {
        // Loser pathway: Wait and check Redis again
        console.log(`[Cache Stampede] Concurrent request detected for ${mediaId}. Waiting 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        // Recursively check cache/DB again
        return await resolveWithCache(mediaId, providerId, scraperTask, dbCheck, dbSave);
    }

    try {
        // Winner pathway: Execute the scraper
        const freshLinks = await scraperTask();

        if (freshLinks.length > 0) {
            // Simultaneously update DB and Redis to avoid stale data (Invalidation Skew)
            if (dbSave) await dbSave(mediaId, providerId, freshLinks);
            await setCachedStreams(mediaId, providerId, freshLinks);
        }
        return freshLinks;
    } finally {
        // Release lock for future requests or errors
        await redis.del(lockKey);
    }
}