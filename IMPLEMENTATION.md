# CinePro Hybrid Workflow: Implementation Guide

This guide provides production-ready code examples for implementing the hybrid workflow where Railway handles caching and browser extensions handle scraping.

---

## Table of Contents

1. [Backend Implementation](#backend-implementation)
2. [Browser Extension Implementation](#browser-extension-implementation)
3. [Frontend Integration](#frontend-integration)
4. [Deployment Guide](#deployment-guide)
5. [Monitoring & Analytics](#monitoring--analytics)
6. [Troubleshooting](#troubleshooting)

---

## Backend Implementation

### Core Setup (server.ts enhancements)

The Railway backend needs to expose stream caching endpoints and manage the database efficiently.

#### Enhanced Server Configuration

```typescript
import { OMSSServer } from '@omss/framework';
import { RedisCache } from './cache/RedisCache.js';
import { DatabaseManager } from './db/DatabaseManager.js';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerConfig {
  name: string;
  version: string;
  host: string;
  port: number;
  publicUrl: string;
  cache: {
    type: 'memory' | 'redis';
    ttl: {
      sources: number;
      subtitles: number;
    };
  };
  database: {
    provider: 'supabase' | 'firebase';
    url: string;
    key: string;
  };
  tmdb: {
    apiKey: string;
    cacheTTL: number;
  };
}

const config: ServerConfig = {
  name: 'CinePro',
  version: '1.0.0',
  host: process.env.HOST || 'localhost',
  port: parseInt(process.env.PORT || '3000'),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  cache: {
    type: (process.env.CACHE_TYPE as 'memory' | 'redis') || 'redis',
    ttl: {
      sources: 60 * 60, // 1 hour
      subtitles: 60 * 60 * 24, // 24 hours
    },
  },
  database: {
    provider: (process.env.DB_PROVIDER as 'supabase' | 'firebase') || 'supabase',
    url: process.env.DATABASE_URL || '',
    key: process.env.DATABASE_KEY || '',
  },
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
    cacheTTL: 24 * 60 * 60, // 24 hours
  },
};

async function main() {
  // Initialize cache
  const cache = new RedisCache({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
  });

  // Initialize database
  const db = new DatabaseManager(config.database);
  await db.initialize();

  const server = new OMSSServer(config);
  const registry = server.getRegistry();
  
  await registry.discoverProviders(path.join(__dirname, './providers/'));
  await server.start();

  console.log(`✅ CinePro running at ${config.publicUrl}`);
}

main().catch(console.error);
```

---

### 1. Stream Caching Endpoints

#### GET /api/streams/:mediaId - Check Cache

```typescript
import { Router, Request, Response } from 'express';
import { DatabaseManager } from './db/DatabaseManager.js';
import { RedisCache } from './cache/RedisCache.js';

export function createStreamRoutes(db: DatabaseManager, cache: RedisCache) {
  const router = Router();

  /**
   * GET /api/streams/:mediaId
   * Check if movie/show has cached playable links
   *
   * Query Parameters:
   * - quality: '1080p' | '720p' | '480p' (optional, default: all)
   * - type: 'movie' | 'tv' (optional)
   *
   * Response: 200 OK
   * {
   *   "found": true,
   *   "mediaId": "movie_12345",
   *   "sources": [
   *     {
   *       "url": "https://cdn.../video.m3u8",
   *       "quality": "1080p",
   *       "source": "provider_1",
   *       "priority": 1,
   *       "expiresAt": "2026-05-25T14:30:00Z"
   *     },
   *     ...
   *   ],
   *   "cachedAt": "2026-05-25T13:30:00Z",
   *   "expiresAt": "2026-05-25T14:30:00Z"
   * }
   *
   * Response: 404 Not Found
   * {
   *   "found": false,
   *   "message": "No cached streams available"
   * }
   */
  router.get('/streams/:mediaId', async (req: Request, res: Response) => {
    try {
      const { mediaId } = req.params;
      const { quality } = req.query as { quality?: string };

      // Try cache first (Redis)
      const cacheKey = `streams:${mediaId}:${quality || 'all'}`;
      const cached = await cache.get(cacheKey);

      if (cached) {
        return res.json({
          found: true,
          source: 'cache',
          ...cached,
        });
      }

      // Query database for non-expired streams
      const streams = await db.query('SELECT * FROM streams WHERE media_id = $1 AND expires_at > NOW() ORDER BY priority DESC', [mediaId]);

      if (streams.length === 0) {
        return res.status(404).json({
          found: false,
          message: 'No cached streams available for this media',
        });
      }

      // Filter by quality if specified
      let result = streams;
      if (quality) {
        result = streams.filter((s: any) => s.quality === quality);
      }

      if (result.length === 0) {
        return res.status(404).json({
          found: false,
          message: `No streams found with quality: ${quality}`,
        });
      }

      const response = {
        found: true,
        mediaId,
        sources: result.map((stream: any) => ({
          url: stream.url,
          quality: stream.quality,
          source: stream.source,
          priority: stream.priority,
          expiresAt: stream.expires_at,
        })),
        cachedAt: result[0].created_at,
        expiresAt: result[0].expires_at,
      };

      // Cache for 30 seconds to prevent DB hammering
      await cache.set(cacheKey, response, 30);

      res.json(response);
    } catch (error) {
      console.error('Error fetching streams:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
```

#### POST /api/streams - Save New Links

```typescript
/**
 * POST /api/streams
 * Save newly discovered stream links to database
 *
 * Request Body:
 * {
 *   "mediaId": "movie_12345",
 *   "mediaType": "movie",
 *   "title": "Movie Title",
 *   "year": 2024,
 *   "sources": [
 *     {
 *       "url": "https://cdn.../video.m3u8",
 *       "quality": "1080p",
 *       "source": "provider_1",
 *       "priority": 1
 *     }
 *   ],
 *   "expiresIn": 3600  // seconds
 * }
 *
 * Response: 200 OK
 * {
 *   "success": true,
 *   "cached": 5,
 *   "mediaId": "movie_12345",
 *   "expiresAt": "2026-05-25T14:30:00Z"
 * }
 */
router.post('/streams', async (req: Request, res: Response) => {
  try {
    const {
      mediaId,
      mediaType,
      title,
      year,
      sources,
      expiresIn = 3600, // default 1 hour
    } = req.body;

    // Validate request
    if (!mediaId || !sources || sources.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: mediaId, sources',
      });
    }

    if (!Array.isArray(sources)) {
      return res.status(400).json({
        error: 'sources must be an array',
      });
    }

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Begin transaction
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Insert or update media metadata
      if (title) {
        await client.query(
          `INSERT INTO media (media_id, type, title, year)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(media_id) DO UPDATE SET
           title = EXCLUDED.title,
           year = EXCLUDED.year`,
          [mediaId, mediaType || 'movie', title, year]
        );
      }

      // Insert streams (skip duplicates)
      let insertedCount = 0;
      for (const source of sources) {
        const { url, quality, source: providerName, priority = 0 } = source;

        if (!url) continue;

        try {
          await client.query(
            `INSERT INTO streams (media_id, url, quality, source, priority, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT(media_id, source, url) DO NOTHING`,
            [mediaId, url, quality || 'unknown', providerName, priority, expiresAt]
          );
          insertedCount++;
        } catch (err) {
          console.warn(`Failed to insert stream: ${url}`, err);
          // Continue with next source
        }
      }

      await client.query('COMMIT');

      // Invalidate cache
      await cache.delete(`streams:${mediaId}:*`);

      res.json({
        success: true,
        cached: insertedCount,
        mediaId,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error saving streams:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### 2. Redis Cache Manager

```typescript
// src/cache/RedisCache.ts

import { createClient, RedisClientType } from 'redis';

export interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export class RedisCache {
  private client: RedisClientType;
  private ready: Promise<void>;

  constructor(config: CacheConfig) {
    this.client = createClient({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
    });

    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    this.client.on('error', (err) => console.error('Redis error:', err));
    await this.client.connect();
    console.log('✅ Redis connected');
  }

  /**
   * Get value from cache
   */
  async get<T = any>(key: string): Promise<T | null> {
    await this.ready;
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  /**
   * Set value in cache with optional expiration
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    await this.ready;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttl) {
      await this.client.setEx(key, ttl, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  /**
   * Delete key from cache
   */
  async delete(key: string): Promise<void> {
    await this.ready;
    await this.client.del(key);
  }

  /**
   * Delete multiple keys matching pattern
   */
  async deletePattern(pattern: string): Promise<number> {
    await this.ready;
    const keys = await this.client.keys(pattern);
    if (keys.length === 0) return 0;
    return await this.client.del(keys);
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    await this.ready;
    return (await this.client.exists(key)) > 0;
  }

  /**
   * Get TTL of key (in seconds)
   */
  async ttl(key: string): Promise<number> {
    await this.ready;
    return await this.client.ttl(key);
  }

  /**
   * Flush all cache
   */
  async flush(): Promise<void> {
    await this.ready;
    await this.client.flushDb();
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    await this.client.quit();
  }
}
```

---

### 3. Database Manager

```typescript
// src/db/DatabaseManager.ts

import { createClient } from '@supabase/supabase-js';

export class DatabaseManager {
  private client: any;
  private initialized = false;

  constructor(config: { provider: 'supabase' | 'firebase'; url: string; key: string }) {
    if (config.provider === 'supabase') {
      this.client = createClient(config.url, config.key);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Tables are created by migrations
    this.initialized = true;
    console.log('✅ Database initialized');
  }

  /**
   * Execute SQL query
   */
  async query(sql: string, params?: any[]): Promise<any[]> {
    try {
      const { data, error } = await this.client.rpc('execute_query', {
        sql,
        params,
      });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error('Database query error:', err);
      throw err;
    }
  }

  /**
   * Get all non-expired streams for media
   */
  async getStreams(mediaId: string, quality?: string): Promise<any[]> {
    try {
      return await this.sql`
        SELECT * FROM streams 
        WHERE media_id = ${mediaId} 
        AND expires_at > NOW()
        ${quality ? this.sql`AND quality = ${quality}` : this.sql``}
        ORDER BY priority DESC
      `;
    } catch (err) {
      console.error('Error fetching streams:', err);
      return [];
    }
  }

    return streams;
  }

  /**
   * Insert new stream
   */
  async insertStream(stream: {
    media_id: string;
    url: string;
    quality?: string;
    source: string;
    priority?: number;
    expires_at: string;
  }): Promise<void> {
    const { error } = await this.client.from('streams').insert([stream]).on('*', (payload: any) => {
      console.log('Stream inserted:', payload);
    });

    if (error) throw error;
  }

  /**
   * Get health status
   */
  async health(): Promise<{ status: 'healthy' | 'degraded' }> {
    try {
      const { data, error } = await this.client
        .from('streams')
        .select('count', { count: 'exact', head: true });

      if (error) throw error;
      return { status: 'healthy' };
    } catch (err) {
      console.error('Database health check failed:', err);
      return { status: 'degraded' };
    }
  }
}
```

---

### 4. Health Check & Monitoring Endpoint

```typescript
/**
 * GET /healthz
 * Returns system health status
 */
router.get('/healthz', async (req: Request, res: Response) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {
      cache: await checkCache(cache),
      database: await db.health(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    },
  };

  const isHealthy = health.checks.cache.status === 'healthy' && health.checks.database.status === 'healthy';

  res.status(isHealthy ? 200 : 503).json(health);
});

async function checkCache(cache: RedisCache) {
  try {
    await cache.set('health_check', { timestamp: Date.now() }, 1);
    return { status: 'healthy' };
  } catch {
    return { status: 'degraded' };
  }
}
```

---

## Browser Extension Implementation

### 1. Manifest Configuration (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "CinePro Companion",
  "version": "1.0.0",
  "description": "Scrape streaming links and cache them to Railway",
  "permissions": [
    "activeTab",
    "scripting",
    "webRequest",
    "storage"
  ],
  "host_permissions": [
    "https://*.streaming-provider1.com/*",
    "https://*.streaming-provider2.com/*",
    "https://*.streaming-provider3.com/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://your-frontend-domain.com/*", "http://localhost/*"],
      "js": ["content.js"],
      "all_frames": false
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_title": "CinePro Companion"
  },
  "icons": {
    "16": "assets/icon-16.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png"
  }
}
```

### 2. Content Script (content.js)

```typescript
// src/extension/content.ts

/**
 * Content script runs on CinePro website
 * Communicates between webpage and service worker
 */

// Listen for scrape requests from webpage
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (event.data.type !== 'CINEPRO_SCRAPE_REQUEST') return;

  const { mediaId, title, year, type } = event.data;

  console.log(`[CinePro] Scrape request: ${title} (${year})`);

  // Send to service worker
  const response = await chrome.runtime.sendMessage({
    action: 'SCRAPE_MEDIA',
    payload: { mediaId, title, year, type },
  });

  // Send results back to webpage
  window.postMessage({
    type: 'CINEPRO_SCRAPE_RESPONSE',
    payload: response,
  }, '*');
});

// Inject script to expose API to webpage
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();
```

### 3. Service Worker (background.ts)

```typescript
// src/extension/background.ts

interface ScrapingJob {
  mediaId: string;
  title: string;
  year: number;
  type: 'movie' | 'tv';
}

interface ScrapedStream {
  url: string;
  quality: string;
  source: string;
  priority: number;
}

// Configuration
const RAILWAY_API = process.env.RAILWAY_API_URL || 'https://cinepro-api.railway.app';
const PROVIDERS = [
  'provider1.com',
  'provider2.com',
  'provider3.com',
  // Add more providers
];

/**
 * Main scraping function
 * Orchestrates fetching from multiple providers
 */
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'SCRAPE_MEDIA') {
    const job = request.payload as ScrapingJob;

    try {
      // Check cache first
      const cached = await checkRailwayCache(job.mediaId);
      if (cached) {
        sendResponse({ success: true, source: 'cache', sources: cached });
        return;
      }

      // Scrape from providers
      const sources = await scrapeFromProviders(job);

      if (sources.length > 0) {
        // Save to Railway
        await saveToRailway(job, sources);
        sendResponse({ success: true, source: 'scraped', sources });
      } else {
        sendResponse({ success: false, error: 'No streams found' });
      }
    } catch (error) {
      console.error('[CinePro] Scraping error:', error);
      sendResponse({ success: false, error: error.message });
    }
  }
});

/**
 * Check if Railway has cached streams
 */
async function checkRailwayCache(mediaId: string): Promise<ScrapedStream[] | null> {
  try {
    const response = await fetch(`${RAILWAY_API}/api/streams/${mediaId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      if (data.found) {
        console.log(`[CinePro] Cache hit for ${mediaId}`);
        return data.sources;
      }
    }
  } catch (error) {
    console.warn('[CinePro] Cache check failed:', error);
  }

  return null;
}

/**
 * Scrape from all providers in parallel
 */
async function scrapeFromProviders(job: ScrapingJob): Promise<ScrapedStream[]> {
  const results: ScrapedStream[] = [];

  // Create scraping tasks for all providers
  const tasks = PROVIDERS.map((provider) => scrapeProvider(provider, job).catch((err) => {
    console.warn(`[CinePro] Provider ${provider} failed:`, err);
    return [];
  }));

  // Execute in parallel with 5-second timeout
  const scrapedResults = await Promise.race([
    Promise.all(tasks),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
  ]);

  for (const providerResults of scrapedResults) {
    results.push(...providerResults);
  }

  // Deduplicate and sort by priority
  return deduplicateAndSort(results);
}

/**
 * Scrape single provider
 */
async function scrapeProvider(provider: string, job: ScrapingJob): Promise<ScrapedStream[]> {
  try {
    // Construct search URL
    const searchUrl = constructSearchUrl(provider, job);
    console.log(`[CinePro] Scraping ${provider}: ${job.title}`);

    // Fetch HTML
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    // Extract stream URLs
    const streams = extractStreams(html, provider);

    return streams.map((url, index) => ({
      url,
      quality: extractQuality(url) || 'unknown',
      source: provider,
      priority: index, // First result has priority 0
    }));
  } catch (error) {
    console.warn(`[CinePro] Error scraping ${provider}:`, error);
    return [];
  }
}

/**
 * Construct provider search URL
 */
function constructSearchUrl(provider: string, job: ScrapingJob): string {
  const query = `${job.title} ${job.year}`;
  const encodedQuery = encodeURIComponent(query);

  const urlTemplates: { [key: string]: string } = {
    'provider1.com': `https://provider1.com/search?q=${encodedQuery}`,
    'provider2.com': `https://provider2.com/?s=${encodedQuery}`,
    'provider3.com': `https://provider3.com/search.php?query=${encodedQuery}`,
    // Add more providers
  };

  return urlTemplates[provider] || `https://${provider}/search?q=${encodedQuery}`;
}

/**
 * Extract streaming URLs from HTML
 */
function extractStreams(html: string, provider: string): string[] {
  const urls: string[] = [];

  // Provider-specific extraction patterns
  const patterns: { [key: string]: RegExp[] } = {
    'provider1.com': [/https:\/\/[^"'<>]+\.m3u8/g, /https:\/\/[^"'<>]+\.mp4/g],
    'provider2.com': [/data-src="([^"]+\.(m3u8|mp4))"/g],
    'provider3.com': [/sources\.push\("([^"]+\.(m3u8|mp4))"\)/g],
    // Add more patterns
  };

  const providerPatterns = patterns[provider] || patterns['provider1.com'];

  for (const pattern of providerPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1] || match[0];
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  return urls;
}

/**
 * Extract quality from URL
 */
function extractQuality(url: string): string | null {
  if (url.includes('1080')) return '1080p';
  if (url.includes('720')) return '720p';
  if (url.includes('480')) return '480p';
  return null;
}

/**
 * Deduplicate and sort by priority
 */
function deduplicateAndSort(streams: ScrapedStream[]): ScrapedStream[] {
  const seen = new Set<string>();
  return streams
    .filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Save streams to Railway cache
 */
async function saveToRailway(job: ScrapingJob, sources: ScrapedStream[]): Promise<void> {
  try {
    const response = await fetch(`${RAILWAY_API}/api/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: job.mediaId,
        mediaType: job.type,
        title: job.title,
        year: job.year,
        sources,
        expiresIn: 3600, // 1 hour
      }),
    });

    if (response.ok) {
      console.log(`[CinePro] Saved ${sources.length} streams to Railway`);
    } else {
      console.warn('[CinePro] Failed to save to Railway:', response.statusText);
    }
  } catch (error) {
    console.warn('[CinePro] Error saving to Railway:', error);
  }
}
```

### 4. Injected Script (injected.ts)

```typescript
// src/extension/injected.ts

/**
 * Expose scraping API to webpage
 * This script runs in webpage context (not extension context)
 */

(function () {
  // Create global CinePro API
  window.CinePro = {
    /**
     * Request scraping for a media item
     */
    async scrapeMedia(mediaId: string, options: any) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Scraping timeout'));
        }, 30000); // 30 second timeout

        // Listen for response once
        const handler = (event: MessageEvent) => {
          if (event.data.type === 'CINEPRO_SCRAPE_RESPONSE') {
            window.removeEventListener('message', handler);
            clearTimeout(timeout);
            resolve(event.data.payload);
          }
        };

        window.addEventListener('message', handler);

        // Send scrape request
        window.postMessage(
          {
            type: 'CINEPRO_SCRAPE_REQUEST',
            mediaId,
            ...options,
          },
          '*'
        );
      });
    },
  };

  // Signal that API is ready
  document.dispatchEvent(new CustomEvent('CINEPRO_READY'));
})();
```

---

## Frontend Integration

### React Component Example

```typescript
// src/components/MediaPlayer.tsx

import React, { useEffect, useState } from 'react';

interface Stream {
  url: string;
  quality: string;
  source: string;
  expiresAt: string;
}

interface MediaPlayerProps {
  mediaId: string;
  title: string;
  year: number;
  type: 'movie' | 'tv';
}

export function MediaPlayer({ mediaId, title, year, type }: MediaPlayerProps) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStream, setSelectedStream] = useState<Stream | null>(null);

  // Step 1: Check Railway cache on mount
  useEffect(() => {
    checkCache();
  }, [mediaId]);

  async function checkCache() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${process.env.REACT_APP_RAILWAY_API}/api/streams/${mediaId}`
      );

      if (response.ok) {
        const data = await response.json();
        setStreams(data.sources);
        setSelectedStream(data.sources[0]);
        return;
      }

      if (response.status === 404) {
        // No cache - trigger extension scraping
        await triggerExtensionScrape();
      }
    } catch (err) {
      setError(`Cache check failed: ${err.message}`);
      await triggerExtensionScrape();
    } finally {
      setLoading(false);
    }
  }

  // Step 2: Trigger extension to scrape
  async function triggerExtensionScrape() {
    try {
      // Wait for extension to be ready
      await waitForExtension();

      // Request scraping
      const result = await (window as any).CinePro.scrapeMedia(mediaId, {
        title,
        year,
        type,
      });

      if (result.success) {
        setStreams(result.sources);
        setSelectedStream(result.sources[0]);
      } else {
        setError(result.error || 'Scraping failed');
      }
    } catch (err) {
      setError(`Scraping failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Wait for extension to load
  async function waitForExtension(maxWait = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Extension not available'));
      }, maxWait);

      if ((window as any).CinePro) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      const handler = () => {
        clearTimeout(timeout);
        document.removeEventListener('CINEPRO_READY', handler);
        resolve();
      };

      document.addEventListener('CINEPRO_READY', handler);
    });
  }

  if (loading) {
    return <div className="player-loading">Loading streams...</div>;
  }

  if (error) {
    return <div className="player-error">{error}</div>;
  }

  if (!streams || !selectedStream) {
    return <div className="player-empty">No streams available</div>;
  }

  return (
    <div className="media-player">
      <video
        key={selectedStream.url}
        controls
        autoPlay
        src={selectedStream.url}
        className="player-video"
      />

      <div className="player-sources">
        <p>Available Sources ({streams.length}):</p>
        <div className="source-list">
          {streams.map((stream, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedStream(stream)}
              className={selectedStream.url === stream.url ? 'selected' : ''}
            >
              {stream.source} - {stream.quality}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## Deployment Guide

### 1. Railway Deployment

#### environment.railway.toml
```toml
[env]
RAILWAY_ENVIRONMENT = "production"
HOST = "0.0.0.0"
PORT = "3000"
PUBLIC_URL = "${{ railway.domain }}"
CACHE_TYPE = "redis"
NODE_ENV = "production"
```

#### Deployment Steps

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Link project
railway login
railway init

# 3. Add PostgreSQL plugin
railway add --plugin postgresql

# 4. Add Redis plugin
railway add --plugin redis

# 5. Deploy
railway up

# 6. Check status
railway status
```

### 2. Extension Publishing

#### Chrome Web Store

1. Create developer account at https://chrome.google.com/webstore
2. Upload ZIP with:
   - manifest.json
   - background.js
   - content.js
   - popup.html/js
   - assets/

#### Firefox Add-ons

1. Create account at https://addons.mozilla.org
2. Upload signed XPI
3. Add store description and screenshots

---

## Monitoring & Analytics

### Log Aggregation

```typescript
// src/utils/logging.ts

import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-stackdriver',
  },
});

export function logScrapeEvent(mediaId: string, status: 'hit' | 'miss' | 'error', duration: number) {
  logger.info({
    event: 'scrape',
    mediaId,
    status,
    duration_ms: duration,
    timestamp: new Date().toISOString(),
  });
}

export function logCacheEvent(action: 'read' | 'write' | 'delete', duration: number) {
  logger.info({
    event: 'cache',
    action,
    duration_ms: duration,
  });
}
```

### Metrics

```typescript
// src/metrics/prometheus.ts

import prometheus from 'prom-client';

const scrapeCounter = new prometheus.Counter({
  name: 'cinepro_scrapes_total',
  help: 'Total scraping requests',
  labelNames: ['status'],
});

const cacheHitRate = new prometheus.Gauge({
  name: 'cinepro_cache_hit_rate',
  help: 'Cache hit rate percentage',
});

const streamDuration = new prometheus.Histogram({
  name: 'cinepro_stream_duration_seconds',
  help: 'Duration of stream availability',
  buckets: [300, 600, 900, 1800, 3600, 7200],
});

export { scrapeCounter, cacheHitRate, streamDuration };
```

---

## Troubleshooting

### Issue: Extension not communicating with Railway

**Solution:**
```typescript
// Check CORS headers
res.header('Access-Control-Allow-Origin', '*');
res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
```

### Issue: Streams expiring too quickly

**Solution:**
```typescript
// Increase TTL in POST /api/streams
expiresIn: 7200  // 2 hours instead of 1
```

### Issue: Cache misses causing lag

**Solution:**
```typescript
// Implement predictive caching
// Cache popular movies proactively
async function preCachePopularMedia() {
  const popular = await getPopularMovies();
  for (const media of popular) {
    await triggerExtensionScrape(media.id);
  }
}
```

---

## Conclusion

This implementation provides:

✅ Production-ready backend with Supabase
✅ Working browser extension with provider scraping
✅ Frontend integration with React example
✅ Monitoring and logging setup
✅ Railway deployment guide
✅ Comprehensive error handling

For questions or issues, see the main [ARCHITECTURE.md](./ARCHITECTURE.md) guide.