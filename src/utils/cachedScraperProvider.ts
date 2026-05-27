/**
 * Base provider utility for cached scraping with rotating IPs
 * Extends BaseProvider with automatic Redis caching and Scraper API routing
 */

import { BaseProvider, type ProviderMediaObject } from '@omss/framework';
import { getScraperApiClient } from './scraperApi.js';
import { getRedisCache } from './redisCache.js';

export interface ScrapedStreamLink {
    url: string;
    headers?: Record<string, string>;
    type: 'mp4' | 'hls';
}

/**
 * Mixin for providers that need cached scraping with rotating IPs
 */
export class CachedScraperMixin {
    /**
     * Fetch through Scraper API with automatic IP rotation
     */
    static async fetchWithRotatingIp(
        url: string,
        headers?: Record<string, string>
    ): Promise<string> {
        const scraperApi = getScraperApiClient();
        const response = await scraperApi.fetch({
            url,
            headers
        });
        return response.body;
    }

    /**
     * Fetch and parse JSON through Scraper API
     */
    static async fetchJsonWithRotatingIp<T = unknown>(
        url: string,
        headers?: Record<string, string>
    ): Promise<T> {
        const scraperApi = getScraperApiClient();
        return await scraperApi.fetchJson<T>({
            url,
            headers
        });
    }

    /**
     * Get cached stream link or null if not found/expired
     */
    static async getCachedStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        season?: number,
        episode?: number
    ): Promise<ScrapedStreamLink | null> {
        const cache = getRedisCache();
        return await cache.getStreamLink(providerId, mediaType, tmdbId, season, episode);
    }

    /**
     * Cache a stream link with 7-day TTL
     */
    static async cacheStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        link: ScrapedStreamLink,
        season?: number,
        episode?: number
    ): Promise<void> {
        const cache = getRedisCache();
        await cache.setStreamLink(providerId, mediaType, tmdbId, link, season, episode);
    }

    /**
     * Invalidate cached stream link
     */
    static async invalidateCachedStreamLink(
        providerId: string,
        mediaType: 'movie' | 'tv',
        tmdbId: number,
        season?: number,
        episode?: number
    ): Promise<void> {
        const cache = getRedisCache();
        await cache.invalidateStreamLink(providerId, mediaType, tmdbId, season, episode);
    }

    /**
     * Wrapper for scraping with automatic caching
     * Usage: const result = await this.scrapeWithCache(providerId, media, async () => { ... scraping logic ... })
     */
    static async scrapeWithCache<T extends ScrapedStreamLink>(
        providerId: string,
        media: ProviderMediaObject,
        scrapeFn: () => Promise<T | null>
    ): Promise<T | null> {
        // Check cache first
        const cached = await this.getCachedStreamLink(
            providerId,
            media.type,
            media.tmdbId,
            media.s,
            media.e
        );

        if (cached) {
            console.log(
                `[${providerId}] Cache hit for ${media.type} ${media.tmdbId}${media.s ? `:s${media.s}e${media.e}` : ''}`
            );
            return cached as T;
        }

        // Perform scraping
        const result = await scrapeFn();

        // Cache successful result
        if (result) {
            await this.cacheStreamLink(
                providerId,
                media.type,
                media.tmdbId,
                result,
                media.s,
                media.e
            );
        }

        return result;
    }
}

