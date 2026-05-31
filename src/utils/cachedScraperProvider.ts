/**
 * CachedScraperProvider
 *
 * A collection of static helper methods that layer Redis caching and
 * ScraperAPI-proxied fetching on top of the standard provider workflow.
 *
 * Usage example inside a provider:
 *
 *   const cached = await CachedScraperProvider.getCached(mediaId, this.id);
 *   if (cached) return this.buildResultFromCache(cached);
 *
 *   const html = await CachedScraperProvider.fetchText(url, { headers });
 *   // … parse html …
 *
 *   await CachedScraperProvider.setCache(mediaId, this.id, {
 *     url, provider: this.id, quality: '1080p', headers: {}
 *   });
 */

import type { ProviderMediaObject, ProviderResult, Source } from '@omss/framework';
import {
    getCachedStreamLink,
    setCachedStreamLink,
    deleteCachedStreamLink,
    type CachedStreamLink,
} from './redisCache.js';
import {
    scraperFetch,
    scraperFetchText,
    scraperFetchJson,
    type ScraperApiOptions,
} from './scraperApi.js';

export class CachedScraperProvider {
    // ------------------------------------------------------------------ //
    //  Cache helpers
    // ------------------------------------------------------------------ //

    /**
     * Look up a cached stream link for the given media + provider pair.
     * Returns `null` on cache miss.
     */
    static async getCached(
        mediaId: string,
        provider: string
    ): Promise<CachedStreamLink | null> {
        return getCachedStreamLink(mediaId, provider);
    }

    /**
     * Persist a stream link to the Redis cache.
     * Returns `true` on success.
     */
    static async setCache(
        mediaId: string,
        provider: string,
        link: Omit<CachedStreamLink, 'cachedAt' | 'expiresAt'>
    ): Promise<boolean> {
        return setCachedStreamLink(mediaId, provider, link);
    }

    /**
     * Remove a cached stream link entry.
     * Returns `true` if an entry was deleted.
     */
    static async invalidateCache(
        mediaId: string,
        provider: string
    ): Promise<boolean> {
        return deleteCachedStreamLink(mediaId, provider);
    }

    // ------------------------------------------------------------------ //
    //  Fetch helpers (ScraperAPI-proxied)
    // ------------------------------------------------------------------ //

    /**
     * Perform a proxied fetch and return the raw `Response`.
     */
    static async fetch(
        url: string,
        init: RequestInit = {},
        options: ScraperApiOptions = {}
    ): Promise<Response> {
        return scraperFetch(url, init, options);
    }

    /**
     * Perform a proxied fetch and return the response body as text.
     * Returns `null` on error or non-OK status.
     */
    static async fetchText(
        url: string,
        init: RequestInit = {},
        options: ScraperApiOptions = {}
    ): Promise<string | null> {
        return scraperFetchText(url, init, options);
    }

    /**
     * Perform a proxied fetch and parse the response body as JSON.
     * Returns `null` on error, non-OK status, or JSON parse failure.
     */
    static async fetchJson<T = unknown>(
        url: string,
        init: RequestInit = {},
        options: ScraperApiOptions = {}
    ): Promise<T | null> {
        return scraperFetchJson<T>(url, init, options);
    }

    // ------------------------------------------------------------------ //
    //  Convenience: cache-first source resolution
    // ------------------------------------------------------------------ //

    /**
     * Attempt to serve a `ProviderResult` from the Redis cache.
     *
     * Returns a fully-formed `ProviderResult` when a valid cache entry
     * exists, or `null` when the caller should proceed with live scraping.
     *
     * @param mediaId  - Unique identifier for the media item (e.g. TMDB ID).
     * @param provider - Provider ID string.
     * @param buildSource - Callback that converts a `CachedStreamLink` into
     *                      a `Source` object using provider-specific logic.
     */
    static async resolveFromCache(
        mediaId: string,
        provider: string,
        buildSource: (cached: CachedStreamLink) => Source
    ): Promise<ProviderResult | null> {
        const cached = await getCachedStreamLink(mediaId, provider);
        if (!cached) {
            return null;
        }

        const source = buildSource(cached);

        return {
            sources: [source],
            subtitles: [],
            diagnostics: [
                {
                    code: 'CACHE_HIT',
                    message: `Served from Redis cache (cached at ${new Date(cached.cachedAt).toISOString()})`,
                    field: '',
                    severity: 'warning',
                },
            ],
        };
    }

    /**
     * Build a media ID string from a `ProviderMediaObject`.
     *
     * For movies: `movie:<tmdbId>`
     * For TV:     `tv:<tmdbId>:s<season>e<episode>`
     */
    static buildMediaId(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `movie:${media.tmdbId}`;
        }
        return `tv:${media.tmdbId}:s${media.s ?? 1}e${media.e ?? 1}`;
    }
}
