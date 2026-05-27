# Scraper API & Redis Cache Integration

This document describes the integration of Scraper API for rotating IPs and Redis caching for stream links in CinePro.

## Overview

The system now implements:
1. **Scraper API Integration**: All scraping requests route through Scraper API to ensure rotating IPs
2. **Redis Caching**: Stream links are cached with a 7-day TTL to reduce redundant scraping
3. **Automatic Cache Checking**: Before triggering new scraping requests, the system checks Redis for existing un-expired links

## Environment Variables

### Required
- `SCRAPER_API_KEY`: Your Scraper API key (get from https://www.scraperapi.com)
- `REDIS_HOST`: Redis server hostname (provided by Railway)
- `REDIS_PORT`: Redis server port (default: 6379)
- `REDIS_PASSWORD`: Redis password (provided by Railway)

### Optional
- `REDIS_PASSWORD`: Redis authentication password (if required)

## Architecture

### Scraper API Client (`src/utils/scraperApi.ts`)

The `ScraperApiClient` class handles all HTTP requests through Scraper API:

```typescript
import { getScraperApiClient } from './utils/scraperApi.js';

const scraperApi = getScraperApiClient();

// Fetch text
const response = await scraperApi.fetch({
    url: 'https://example.com',
    headers: { 'User-Agent': '...' }
});

// Fetch and parse JSON
const data = await scraperApi.fetchJson<MyType>({
    url: 'https://api.example.com/data'
});
```

**Features:**
- Automatic IP rotation via Scraper API
- Exponential backoff retry logic (3 attempts)
- Configurable timeout (30s default)
- Render engine fallback on retries

### Redis Cache (`src/utils/redisCache.ts`)

The `RedisStreamCache` class manages stream link caching:

```typescript
import { getRedisCache } from './utils/redisCache.js';

const cache = getRedisCache();

// Check cache
const cached = await cache.getStreamLink(
    'provider-id',
    'movie',
    12345
);

// Store in cache (7-day TTL)
await cache.setStreamLink(
    'provider-id',
    'movie',
    12345,
    {
        url: 'https://stream.example.com/video.mp4',
        type: 'mp4'
    }
);

// Invalidate
await cache.invalidateStreamLink('provider-id', 'movie', 12345);
```

**Cache Key Format:**
- Movies: `stream_links:{providerId}:movie:{tmdbId}`
- TV: `stream_links:{providerId}:tv:{tmdbId}:s{season}e{episode}`

**TTL:** 7 days (604,800 seconds)

### Cached Scraper Mixin (`src/utils/cachedScraperProvider.ts`)

Helper utilities for providers to implement caching:

```typescript
import { CachedScraperMixin } from './utils/cachedScraperProvider.js';

// Fetch with rotating IP
const html = await CachedScraperMixin.fetchWithRotatingIp(url, headers);

// Fetch JSON with rotating IP
const data = await CachedScraperMixin.fetchJsonWithRotatingIp<MyType>(url);

// Scrape with automatic caching
const result = await CachedScraperMixin.scrapeWithCache(
    'provider-id',
    media,
    async () => {
        // Your scraping logic here
        return { url: '...', type: 'mp4' };
    }
);
```

## Provider Implementation

### Updated Tulnex Provider

The Tulnex provider now:
1. Checks Redis cache before scraping
2. Routes all requests through Scraper API
3. Caches successful results with 7-day TTL

```typescript
private async doScrape(serverName: string, media: ProviderMediaObject) {
    // Check cache first
    const cache = getRedisCache();
    const cached = await cache.getStreamLink(
        this.id,
        media.type,
        media.tmdbId,
        media.s,
        media.e
    );

    if (cached) {
        console.log(`[${this.name}] Cache hit`);
        return cached;
    }

    // Route through Scraper API
    const scraperApi = getScraperApiClient();
    const response = await scraperApi.fetchJson<TulnexApiResponse>({
        url: targetUrl,
        headers: this.HEADERS
    });

    // Process and cache result
    const result = extractUrl(response.payload);
    if (result) {
        await cache.setStreamLink(
            this.id,
            media.type,
            media.tmdbId,
            result,
            media.s,
            media.e
        );
    }

    return result;
}
```

## Implementing in Other Providers

To add caching and rotating IPs to other providers:

### Option 1: Using CachedScraperMixin (Recommended)

```typescript
import { CachedScraperMixin } from '../../utils/cachedScraperProvider.js';

private async doScrape(media: ProviderMediaObject) {
    return await CachedScraperMixin.scrapeWithCache(
        this.id,
        media,
        async () => {
            // Your scraping logic
            const data = await CachedScraperMixin.fetchJsonWithRotatingIp(url);
            return { url: data.streamUrl, type: 'mp4' };
        }
    );
}
```

### Option 2: Manual Implementation

```typescript
import { getScraperApiClient } from '../../utils/scraperApi.js';
import { getRedisCache } from '../../utils/redisCache.js';

private async doScrape(media: ProviderMediaObject) {
    const cache = getRedisCache();
    
    // Check cache
    const cached = await cache.getStreamLink(
        this.id,
        media.type,
        media.tmdbId,
        media.s,
        media.e
    );
    if (cached) return cached;

    // Scrape with rotating IP
    const scraperApi = getScraperApiClient();
    const response = await scraperApi.fetchJson(url);
    
    // Cache result
    const result = processResponse(response);
    if (result) {
        await cache.setStreamLink(
            this.id,
            media.type,
            media.tmdbId,
            result,
            media.s,
            media.e
        );
    }
    
    return result;
}
```

## Cache Statistics

Get cache statistics via the Redis cache instance:

```typescript
const cache = getRedisCache();
const stats = await cache.getStats();
console.log(`Cached streams: ${stats.totalKeys}`);
console.log(`TTL: ${stats.ttl} seconds (${stats.ttl / 86400} days)`);
console.log(`Connected: ${stats.connected}`);
```

## Monitoring

### Cache Hit Rate
Monitor logs for cache hits:
```
[provider-id] Cache hit for movie 12345
```

### Scraper API Usage
Monitor Scraper API dashboard for:
- Request count
- Success rate
- IP rotation effectiveness
- Response times

### Redis Connection
Monitor Redis connection status:
```
Redis cache connected
```

## Performance Considerations

1. **Cache Warmup**: First request for a stream will be slower (Scraper API + processing)
2. **Cache Hits**: Subsequent requests within 7 days are instant
3. **Memory**: Redis stores serialized JSON objects (~500 bytes per entry)
4. **Network**: Scraper API adds ~1-3 seconds per request

## Troubleshooting

### Cache Not Working
1. Check Redis connection: `redis-cli ping`
2. Verify `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
3. Check Redis logs for errors

### Scraper API Failures
1. Verify `SCRAPER_API_KEY` is valid
2. Check Scraper API dashboard for quota/limits
3. Review error logs for specific failure reasons
4. Retry logic will attempt 3 times with exponential backoff

### High Cache Miss Rate
1. Check if Redis is connected
2. Verify cache TTL is appropriate (7 days)
3. Monitor cache size: `redis-cli DBSIZE`

## Future Enhancements

- [ ] Cache invalidation webhooks
- [ ] Cache warming strategies
- [ ] Per-provider cache TTL configuration
- [ ] Cache compression for large responses
- [ ] Distributed cache across multiple Redis instances
- [ ] Cache analytics dashboard

