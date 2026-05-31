import { getCachedStreams, setCachedStreams, CachedStream } from './redisCache.js';

/**
 * Helper to handle the cache-first scraping logic.
 */
export async function resolveWithCache(
    mediaId: string,
    providerId: string,
    scraperTask: () => Promise<CachedStream[]>
): Promise<CachedStream[]> {
    // 1. Check Redis cache first
    const cached = await getCachedStreams(mediaId, providerId);
    if (cached && cached.length > 0) {
        console.log(`[Cache Hit] Serving ${cached.length} links for ${mediaId}`);
        return cached;
    }

    // 2. Scrape if not cached
    const freshLinks = await scraperTask();

    // 3. Save to Redis if results were found
    if (freshLinks.length > 0) {
        await setCachedStreams(mediaId, providerId, freshLinks);
    }

    return freshLinks;
}