import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { generateRandomUserAgent } from '../../utils/ua.js';
import { TulnexApiResponse } from './tulnex.types.js';
import { decryptPayload } from './decrypt.js';
import { extractUrl } from './tulnex.mapper.js';
import { getScraperApiClient } from '../../utils/scraperApi.js';
import { getRedisCache } from '../../utils/redisCache.js';

export class TulnexProvider extends BaseProvider {
    readonly id = 'tulnex';
    readonly name = 'Tulnex';
    readonly enabled = true;

    readonly BASE_URL = 'https://api.tulnex.com';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache'
    };

    readonly SERVERS = [
        `onion`,
        `vidzee`,
        `icefy`,
        `tik`,
        `vaplayer`,
        `vidfast-alpha`,
        `uniquestream`,
        `vidfast-mega`,
        `vidfast-vrapid`,
        `allmovies`,
        `vidlink`,
        `vidfast-vedge`,
        `vidfast-vfast`,
        `moviebox`
    ];

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return await this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return await this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            const results = await Promise.allSettled(
                this.SERVERS.map((server) => this.doScrape(server, media))
            );

            const successful = results
                .filter(
                    (
                        r
                    ): r is PromiseFulfilledResult<
                        Awaited<ReturnType<typeof this.doScrape>>
                    > => r.status === 'fulfilled' && r.value != null
                )
                .map((r) => r.value);

            return {
                sources: successful
                    .filter((r) => r !== null)
                    .map((r) => ({
                        url: this.createProxyUrl(
                            r.url,
                            r.headers ? r.headers : {}
                        ),
                        type:
                            r.url.includes('mkv') || r.url.includes('mp4')
                                ? 'mp4'
                                : 'hls',
                        audioTracks: [
                            {
                                label: 'Original',
                                language: 'Original'
                            }
                        ],
                        quality: 'Auto',
                        provider: {
                            name: this.name,
                            id: this.id
                        }
                    })),
                subtitles: [],
                diagnostics: []
            };
        } catch (e) {
            return this.emptyResult(
                e instanceof Error ? e.message : 'Unknown provider error'
            );
        }
    }

    private async doScrape(serverName: string, media: ProviderMediaObject) {
        // Check Redis cache first
        const cache = getRedisCache();
        const cached = await cache.getStreamLink(
            this.id,
            media.type,
            media.tmdbId,
            media.s,
            media.e
        );

        if (cached) {
            console.log(
                `[${this.name}] Cache hit for ${media.type} ${media.tmdbId}${media.s ? `:s${media.s}e${media.e}` : ''}`
            );
            return cached;
        }

        // Build the target URL
        const targetUrl =
            media.type === 'movie'
                ? `${this.BASE_URL}/${serverName}/movie/${media.tmdbId}`
                : `${this.BASE_URL}/${serverName}/tv/${media.tmdbId}/${media.s}/${media.e}`;

        try {
            // Route through Scraper API for rotating IPs
            const scraperApi = getScraperApiClient();
            const response = await scraperApi.fetchJson<TulnexApiResponse>(
                {
                    url: targetUrl,
                    headers: { ...this.HEADERS, Accept: 'application/json, */*' }
                }
            );

            if (!response.payload) {
                return null;
            }

            const decrypted = await decryptPayload(response.payload);
            if (!decrypted) {
                return null;
            }

            const result = extractUrl(decrypted);
            
            if (result) {
                // Cache the successful result with 7-day TTL
                await cache.setStreamLink(
                    this.id,
                    media.type,
                    media.tmdbId,
                    {
                        url: result.url,
                        headers: result.headers,
                        type: result.url.includes('mkv') || result.url.includes('mp4') ? 'mp4' : 'hls'
                    },
                    media.s,
                    media.e
                );
            }

            return result;
        } catch (error) {
            console.error(
                `[${this.name}] Error scraping ${serverName}:`,
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const scraperApi = getScraperApiClient();
            const response = await scraperApi.fetch({
                url: this.BASE_URL,
                method: 'GET'
            });
            return response.statusCode === 200;
        } catch {
            return false;
        }
    }
}

