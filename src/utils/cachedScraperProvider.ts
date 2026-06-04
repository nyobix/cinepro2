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
    dbSave?: (mediaId: string, providerId: string, streams: CachedStream[]) => Promise<void>,
    attempt: number = 0
): Promise<CachedStream[]> {
    const MAX_STAMPEDE_RETRIES = 3;

    // --- Scenario A: Absolute Cache HIT (Redis) ---
    const cached = await getCachedStreams(mediaId, providerId);
    if (cached && cached.length > 0) {
        console.log(`[Scenario A] Redis Hit: Serving ${cached.length} links for ${mediaId}`);
        return cached;
    }

    // --- Scenario B: Tier-2 Cache HIT (Supabase Vault) ---
    if (dbCheck) {
        const dbCached = await dbCheck(mediaId, providerId);
        if (dbCached && dbCached.length > 0) {
            console.log(`[Scenario B] DB Hit: Returning data and re-warming Redis for ${mediaId}`);
            // Background Re-warm: Do not await, let the response return immediately
            setCachedStreams(mediaId, providerId, dbCached).catch(err =>
                console.error('[Redis Re-warm Error]:', err),
            );
            return dbCached;
        }
    }

    // --- Scenario C: Ultimate Cache MISS & Stampede Protection ---
    const lockKey = `lock:${providerId}:${mediaId}`;
    if (!redis) return await scraperTask();

    // Attempt to acquire distributed lock (SET NX EX) - valid for 15 seconds
    const acquired = await redis.set(lockKey, 'locked', 'EX', 15, 'NX');

    if (acquired !== 'OK' && attempt < MAX_STAMPEDE_RETRIES) {
        // Loser pathway: Wait and check Redis again
        console.log(`[Scenario C] Stampede Protection: Waiting 500ms for ${mediaId} (Attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Re-check both cache layers
        return await resolveWithCache(mediaId, providerId, scraperTask, dbCheck, dbSave, attempt + 1);
    }

    try {
        // Winner pathway: Only one process executes the expensive scraper task
        console.log(`[Scenario C] Lock Acquired: Executing scraper for ${mediaId}`);
        const freshLinks = await scraperTask();

        if (freshLinks.length > 0) {
            // Critical: Align both layers simultaneously to prevent Invalidation Skew
            await Promise.all([
                dbSave ? dbSave(mediaId, providerId, freshLinks) : Promise.resolve(),
                setCachedStreams(mediaId, providerId, freshLinks),
            ]);
        }
        return freshLinks;
    } finally {
        // Release lock immediately after work is done or on error
        await redis.del(lockKey);
    }
}