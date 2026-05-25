# CinePro Hybrid Workflow Implementation Guide

## Quick Reference

**The Hybrid Workflow in 5 Steps:**

1. 👤 **User clicks Play** → Frontend requests cached link from Railway
2. ⚡ **Cache Hit** (optional) → Railway returns existing link, video plays instantly
3. 🔍 **Cache Miss** → Extension scrapes from user's home IP, extracts 5-50+ sources
4. 🔄 **Links Return** → Extension sends discovered links back to frontend
5. 💾 **Cache Stored** → Frontend uploads links to Railway with 1-hour TTL

---

## Implementation: Backend (Railway)

### Core Endpoint: Check/Get Stream

**Endpoint:** `GET /api/streams/:mediaId`

**Purpose:** Primary entry point when user clicks "Play"

```typescript
// src/api/routes/streams.ts

import { Request, Response } from 'express';
import { StreamCache } from '../cache/StreamCache';
import { Database } from '../db/Database';

export async function getStream(req: Request, res: Response) {
  try {
    const { mediaId } = req.params;
    const { quality = 'any', source = 'any' } = req.query;

    // Step 1: Check Redis cache first (< 1ms)
    const cachedLinks = await StreamCache.get(mediaId, {
      quality: quality as string,
      source: source as string
    });

    if (cachedLinks && cachedLinks.length > 0) {
      // CACHE HIT - Return immediately
      return res.json({
        status: 'cached',
        sources: cachedLinks,
        cachedAt: new Date(),
        expiresAt: cachedLinks[0].expiresAt,
        requiresExtension: false
      });
    }

    // Step 2: Check database as fallback
    const dbLinks = await Database.getValidStreams(mediaId);

    if (dbLinks && dbLinks.length > 0) {
      // Database hit (cache expired but links may still be valid)
      await StreamCache.set(mediaId, dbLinks);
      
      return res.json({
        status: 'database',
        sources: dbLinks,
        cachedAt: dbLinks[0].createdAt,
        expiresAt: dbLinks[0].expiresAt,
        requiresExtension: false
      });
    }

    // Step 3: No cache - trigger extension scraping
    return res.status(404).json({
      status: 'not_cached',
      mediaId: mediaId,
      message: 'Please use the browser extension to scrape this media',
      action: 'EXTENSION_SCRAPE_REQUIRED',
      requiresExtension: true,
      extensionMessage: {
        mediaId: mediaId,
        action: 'SCRAPE'
      }
    });

  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

### Core Endpoint: Save Discovered Links

**Endpoint:** `POST /api/streams`

**Purpose:** Receive and cache links from browser extension

```typescript
// src/api/routes/streams.ts

export async function saveStreams(req: Request, res: Response) {
  try {
    const {
      mediaId,
      mediaType = 'movie',
      title,
      year,
      sources,
      expiresIn = 3600  // Default 1 hour
    } = req.body;

    // Validation
    if (!mediaId || !sources || sources.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: mediaId, sources'
      });
    }

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    // Prepare stream records
    const streamRecords = sources.map((source: any, index: number) => ({
      mediaId,
      mediaType,
      url: source.url,
      quality: source.quality || 'unknown',
      source: source.source || 'extension',
      priority: index,  // First source = highest priority
      working: true,
      expiresAt,
      metadata: {
        headers: source.headers || {},
        userAgent: req.get('user-agent'),
        clientIp: getClientIp(req)
      }
    }));

    // Step 1: Save to database
    const saved = await Database.saveStreams(streamRecords);

    if (!saved) {
      return res.status(500).json({ error: 'Failed to save streams' });
    }

    // Step 2: Update cache
    await StreamCache.set(mediaId, streamRecords, expiresIn);

    // Step 3: Store media metadata if provided
    if (title) {
      await Database.upsertMedia({
        tmdbId: mediaId,
        type: mediaType,
        title,
        year,
        metadata: { sources: sources.length }
      });
    }

    return res.json({
      status: 'success',
      mediaId,
      streamsSaved: saved.length,
      expiresAt,
      message: `${saved.length} stream(s) cached for ${expiresIn / 3600} hour(s)`
    });

  } catch (error) {
    console.error('Error saving streams:', error);
    res.status(500).json({ error: 'Failed to save streams' });
  }
}
```

### Health Check Endpoint

**Endpoint:** `GET /api/health`

**Purpose:** Monitor cache and database connectivity

```typescript
export async function healthCheck(req: Request, res: Response) {
  try {
    const checks = {
      server: 'ok',
      cache: await StreamCache.ping() ? 'ok' : 'error',
      database: await Database.ping() ? 'ok' : 'error',
      timestamp: new Date(),
      version: '1.0.0'
    };

    const allOk = Object.values(checks)
      .filter(v => typeof v === 'string')
      .every(v => v === 'ok');

    res.status(allOk ? 200 : 503).json(checks);
  } catch (error) {
    res.status(503).json({
      server: 'error',
      error: error.message
    });
  }
}
```

### Stream Monitoring Endpoint

**Endpoint:** `GET /api/streams/:mediaId/status`

**Purpose:** Check if cached links are still working

```typescript
export async function checkStreamStatus(req: Request, res: Response) {
  try {
    const { mediaId } = req.params;
    const links = await Database.getValidStreams(mediaId);

    if (!links || links.length === 0) {
      return res.status(404).json({ status: 'not_cached' });
    }

    // Verify links are still valid
    const linkStatuses = await Promise.all(
      links.map(link => verifyLink(link))
    );

    const working = linkStatuses.filter(s => s.working).length;
    const total = linkStatuses.length;

    res.json({
      mediaId,
      total,
      working,
      quality: 'good',
      linkStatuses,
      recommendation: working > 0 ? 'use_cache' : 'rescrape'
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function verifyLink(link: StreamRecord): Promise<any> {
  try {
    const response = await fetch(link.url, { method: 'HEAD' });
    return {
      url: link.url,
      working: response.ok,
      status: response.status
    };
  } catch {
    return {
      url: link.url,
      working: false,
      status: 'unreachable'
    };
  }
}
```

---

## Implementation: Cache Layer

### Redis Cache Manager

```typescript
// src/cache/StreamCache.ts

import Redis from 'ioredis';

export class StreamCache {
  private static redis: Redis;

  static async init() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD
    });

    console.log('✅ Redis cache initialized');
  }

  // Get cached links for a media
  static async get(
    mediaId: string,
    filters?: { quality?: string; source?: string }
  ): Promise<StreamRecord[] | null> {
    try {
      const key = `streams:${mediaId}`;
      const cached = await this.redis.get(key);

      if (!cached) return null;

      const links = JSON.parse(cached);

      // Apply filters if provided
      if (filters?.quality && filters.quality !== 'any') {
        return links.filter((l: any) => l.quality === filters.quality);
      }

      if (filters?.source && filters.source !== 'any') {
        return links.filter((l: any) => l.source === filters.source);
      }

      return links;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  // Set cache with TTL
  static async set(
    mediaId: string,
    links: StreamRecord[],
    ttlSeconds: number = 3600
  ): Promise<boolean> {
    try {
      const key = `streams:${mediaId}`;
      await this.redis.setex(
        key,
        ttlSeconds,
        JSON.stringify(links)
      );

      console.log(`📦 Cached ${links.length} links for ${mediaId} (${ttlSeconds}s TTL)`);
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  // Delete expired cache
  static async delete(mediaId: string): Promise<boolean> {
    try {
      const key = `streams:${mediaId}`;
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  // Get cache statistics
  static async stats(): Promise<any> {
    try {
      const info = await this.redis.info('memory');
      const keys = await this.redis.dbsize();

      return {
        totalKeys: keys,
        memory: info,
        uptime: new Date()
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // Health check
  static async ping(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
```

---

## Implementation: Database

### Streams Table Operations

```typescript
// src/db/Database.ts

import { SupabaseClient } from '@supabase/supabase-js';

export class Database {
  private static client: SupabaseClient;

  static async init() {
    this.client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!
    );
  }

  // Save multiple streams
  static async saveStreams(records: StreamRecord[]): Promise<any[]> {
    const { data, error } = await this.client
      .from('streams')
      .upsert(records, { onConflict: 'media_id,source,url' })
      .select();

    if (error) throw error;
    return data || [];
  }

  // Get valid (non-expired) streams
  static async getValidStreams(
    mediaId: string,
    quality?: string
  ): Promise<StreamRecord[]> {
    let query = this.client
      .from('streams')
      .select('*')
      .eq('media_id', mediaId)
      .gt('expires_at', new Date().toISOString())
      .eq('working', true)
      .order('priority', { ascending: true });

    if (quality && quality !== 'any') {
      query = query.eq('quality', quality);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  }

  // Mark stream as broken
  static async markBroken(streamId: string): Promise<boolean> {
    const { error } = await this.client
      .from('streams')
      .update({ working: false })
      .eq('id', streamId);

    if (error) {
      console.error('Error marking stream broken:', error);
      return false;
    }
    return true;
  }

  // Cleanup expired streams (run daily)
  static async cleanupExpired(): Promise<number> {
    const { data, error } = await this.client
      .from('streams')
      .delete()
      .lt('expires_at', new Date().toISOString());

    if (error) throw error;
    return data?.length || 0;
  }

  // Database health check
  static async ping(): Promise<boolean> {
    try {
      const { error } = await this.client
        .from('streams')
        .select('count()', { count: 'exact', head: true });
      return !error;
    } catch {
      return false;
    }
  }

  // Upsert media metadata
  static async upsertMedia(media: MediaRecord): Promise<any> {
    const { data, error } = await this.client
      .from('media')
      .upsert([media], { onConflict: 'tmdb_id' })
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
```

---

## Implementation: Browser Extension (Client-Side)

### Content Script: Handle Scraping Request

```typescript
// extension/scripts/content.ts

interface ScrapeRequest {
  mediaId: string;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
}

interface StreamSource {
  url: string;
  quality: string;
  source: string;
  headers?: Record<string, string>;
}

// Listen for scrape requests from webpage
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const message = event.data;

  if (message.type === 'CINEPRO_SCRAPE_REQUEST') {
    console.log('🎬 Extension received scrape request:', message.data);

    try {
      const scrapeRequest: ScrapeRequest = message.data;
      const sources = await scrapeStreamLinks(scrapeRequest);

      // Step 1: Send back to webpage
      window.postMessage({
        type: 'CINEPRO_SCRAPE_RESPONSE',
        data: {
          success: true,
          mediaId: scrapeRequest.mediaId,
          sources: sources,
          count: sources.length
        }
      }, '*');

      // Step 2: Send to Railway backend for caching
      await saveToRailway(scrapeRequest, sources);

    } catch (error) {
      console.error('❌ Scraping error:', error);

      window.postMessage({
        type: 'CINEPRO_SCRAPE_RESPONSE',
        data: {
          success: false,
          error: error.message
        }
      }, '*');
    }
  }
});

// Main scraping function
async function scrapeStreamLinks(
  request: ScrapeRequest
): Promise<StreamSource[]> {
  const sources: StreamSource[] = [];

  // Example: Scrape from multiple providers
  // This is where your provider-specific scraping logic goes

  // Provider 1: HLS Stream
  try {
    const hls = await scrapeProvider1(request.title, request.year);
    if (hls) {
      sources.push({
        url: hls.url,
        quality: hls.quality || '720p',
        source: 'provider_1'
      });
    }
  } catch (error) {
    console.error('Provider 1 error:', error);
  }

  // Provider 2: MP4
  try {
    const mp4 = await scrapeProvider2(request.title, request.year);
    if (mp4) {
      sources.push({
        url: mp4.url,
        quality: mp4.quality || '1080p',
        source: 'provider_2'
      });
    }
  } catch (error) {
    console.error('Provider 2 error:', error);
  }

  // ... more providers

  console.log(`✅ Found ${sources.length} stream sources`);
  return sources;
}

// Send scraped links to Railway for caching
async function saveToRailway(
  request: ScrapeRequest,
  sources: StreamSource[]
) {
  const RAILWAY_API = process.env.RAILWAY_API_URL;

  try {
    const response = await fetch(`${RAILWAY_API}/api/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: request.mediaId,
        mediaType: request.mediaType,
        title: request.title,
        year: request.year,
        sources: sources,
        expiresIn: 3600  // 1 hour cache
      })
    });

    const result = await response.json();
    console.log('💾 Saved to Railway:', result);

    return result;
  } catch (error) {
    console.error('Error saving to Railway:', error);
    // Don't throw - scraping succeeded even if caching failed
  }
}
```

### Webpage Integration

```typescript
// website/js/cinepro-player.ts

interface PlayRequest {
  mediaId: string;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
}

export class CinepProPlayer {
  static async play(request: PlayRequest) {
    console.log('▶️ Play request:', request);

    // Step 1: Request from Railway cache
    const cached = await this.getFromRailway(request.mediaId);

    if (cached?.sources && cached.sources.length > 0) {
      console.log('⚡ Cache hit! Using cached links');
      this.playStream(cached.sources[0]);
      return;
    }

    console.log('🔍 Cache miss, requesting extension scrape...');

    // Step 2: Request browser extension to scrape
    const result = await this.requestExtensionScrape(request);

    if (result.success && result.sources.length > 0) {
      console.log('✅ Scraping complete! Playing stream...');
      this.playStream(result.sources[0]);
    } else {
      console.error('❌ Scraping failed:', result.error);
      alert('Unable to find playable stream. Please try again.');
    }
  }

  private static async getFromRailway(mediaId: string): Promise<any> {
    try {
      const response = await fetch(
        `${process.env.RAILWAY_API}/api/streams/${mediaId}`
      );
      return await response.json();
    } catch (error) {
      console.error('Error fetching from Railway:', error);
      return null;
    }
  }

  private static requestExtensionScrape(
    request: PlayRequest
  ): Promise<{ success: boolean; sources: any[] }> {
    return new Promise((resolve) => {
      // Listen for extension response
      const handler = (event: MessageEvent) => {
        if (event.data.type === 'CINEPRO_SCRAPE_RESPONSE') {
          window.removeEventListener('message', handler);
          resolve(event.data.data);
        }
      };

      window.addEventListener('message', handler);

      // Send scrape request to extension
      window.postMessage({
        type: 'CINEPRO_SCRAPE_REQUEST',
        data: request
      }, '*');

      // Timeout after 30 seconds
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ success: false, sources: [] });
      }, 30000);
    });
  }

  private static playStream(source: any) {
    // Play the stream using HLS.js or similar
    console.log('Playing:', source.url);
    // ... player implementation
  }
}
```

---

## Deployment Checklist

### Railway Setup

- [ ] Create Railway project
- [ ] Configure environment variables (see ARCHITECTURE.md)
- [ ] Set up PostgreSQL/Supabase database
- [ ] Deploy backend code
- [ ] Configure Redis cache
- [ ] Set PUBLIC_URL to Railway domain
- [ ] Enable HTTPS

### Browser Extension

- [ ] Manifest v3 configuration
- [ ] Content script registration
- [ ] Request permissions
- [ ] Test on local server
- [ ] Package and publish to Chrome Web Store

### Database

- [ ] Create `streams` table
- [ ] Create `media` table
- [ ] Set up indexes
- [ ] Configure replication/backups
- [ ] Set row-level security policies

### Monitoring

- [ ] Set up error logging (Sentry)
- [ ] Monitor cache hit/miss ratio
- [ ] Track API response times
- [ ] Monitor database query performance
- [ ] Alert on service degradation

---

## Testing the Workflow

### Manual Test

1. Open CinePro web UI
2. Search for a movie
3. Click "Play"
4. Verify cache check happens first
5. Verify extension scraping triggers if cache miss
6. Verify links are returned
7. Verify video plays
8. Check Railway logs for proper requests

### Load Test (Simulate 5,000 Users)

```bash
# Use k6 or Apache JMeter
k6 run --vus 100 --duration 300s load-test.js
```

### Cache Effectiveness

```typescript
// Monitor cache metrics
const metrics = {
  requests: 10000,
  cacheHits: 9000,
  cacheMisses: 1000,
  hitRate: (9000 / 10000) * 100  // 90%
};

console.log(`Cache efficiency: ${metrics.hitRate}%`);
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Cache not working | Redis connection failed | Check REDIS_HOST, REDIS_PORT |
| 404 on links | Links expired | Check STREAM_CACHE_TTL setting |
| Extension not scraping | Missing permissions | Add host permissions in manifest |
| Slow responses | Database queries slow | Add indexes, check query plans |
| IP getting banned | Too many requests | Implement rate limiting per source |

---

This hybrid workflow is the key to scaling to 5,000+ users sustainably. All components work together to provide instant playback for cached content while seamlessly triggering client-side scraping when needed.
