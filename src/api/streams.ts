import { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { StreamCache } from '../StreamCache.js';
import { Database } from '../Database.js';

const THREE_DAYS_SECONDS = 259200;
const THREE_DAYS_MS = THREE_DAYS_SECONDS * 1000;

interface StreamSource {
  url: string;
  quality?: string;
  source: string;
  priority?: number;
  headers?: Record<string, string>;
}

export async function getStream(request: FastifyRequest, reply: FastifyReply) {
  const mediaId = String((request.params as any)?.mediaId ?? '');
  const query = request.query as Record<string, string | undefined>;
  const title = query.title;
  const year = query.year;
  const type = query.type;

  if (!mediaId) {
    return reply.status(400).send({ error: 'Media ID required' });
  }

  try {
    const cachedLinks = await StreamCache.get(mediaId);
    if (Array.isArray(cachedLinks) && cachedLinks.length > 0) {
      return reply.send({ status: 'success', sources: cachedLinks, source: 'cache_hot' });
    }

    const dbLinks = await Database.getValidStreams(mediaId);
    if (Array.isArray(dbLinks) && dbLinks.length > 0) {
      await StreamCache.set(mediaId, dbLinks, THREE_DAYS_SECONDS);
      return reply.send({ status: 'success', sources: dbLinks, source: 'database_persistent' });
    }

    const inProgress = await StreamCache.isScrapeInProgress(mediaId);
    if (inProgress) {
      return reply.status(202).send({
        status: 'pending',
        message: 'This media is being prepared by another user. Please wait a few seconds...',
      });
    }

    const hasLock = await StreamCache.acquireScrapeLock(mediaId);
    if (!hasLock) {
      return reply.status(202).send({
        status: 'pending',
        message: 'Scrape in progress by another user. Please retry in 5 seconds.',
      });
    }

    try {
      const scraperKey = process.env.SCRAPER_API_KEY;
      if (!scraperKey) {
        return reply.status(500).send({ error: 'Scraper API key is not configured' });
      }

      const normalizedType = normalizeMediaType(type);
      const targetUrl = `https://vidsrc.to/embed/${normalizedType}/${mediaId}`;
      console.log(`Triggering Scraper API for ${targetUrl}`);

      const scraperUrl = `https://api.scraperapi.com?api_key=${encodeURIComponent(scraperKey)}&url=${encodeURIComponent(targetUrl)}&render=true&keep_headers=true&cb=${Date.now()}`;
      let response: any;
      try {
        response = await axios.get(scraperUrl, { timeout: 30000 });
      } catch (err: any) {
        console.error('[Streams] ScraperAPI request failed', {
          message: err?.message,
          code: err?.code,
          status: err?.response?.status,
        });

        // Save response HTML if present for post-mortem
        try {
          const logsDir = path.resolve(process.cwd(), 'logs');
          fs.mkdirSync(logsDir, { recursive: true });
          const dump = err?.response?.data ? String(err.response.data).slice(0, 200000) : `No response body; error: ${err?.message}`;
          const fileName = path.join(logsDir, `scraper_error_${mediaId}_${Date.now()}.html`);
          fs.writeFileSync(fileName, dump, 'utf8');
          console.error('[Streams] Wrote scraper error HTML to', fileName);
        } catch (werr) {
          console.error('[Streams] Failed to write scraper error file', werr);
        }

        return reply.status(502).send({ error: 'ScraperAPI request failed', details: err?.code || err?.message });
      }

      const sources = parseSources(response.data, targetUrl);

      if (!sources || sources.length === 0) {
        console.warn('[Streams] No sources extracted from ScraperAPI response for', mediaId);
        // Dump a snippet of the HTML for debugging
        try {
          const logsDir = path.resolve(process.cwd(), 'logs');
          fs.mkdirSync(logsDir, { recursive: true });
          const html = response?.data ? String(response.data).slice(0, 200000) : 'NO_HTML';
          const fileName = path.join(logsDir, `scraper_nosources_${mediaId}_${Date.now()}.html`);
          fs.writeFileSync(fileName, html, 'utf8');
          console.warn('[Streams] Saved ScraperAPI HTML sample to', fileName);
        } catch (werr) {
          console.error('[Streams] Failed to save HTML sample', werr);
        }

        return reply.status(404).send({ error: 'No streams found via Scraper API' });
      }

      const streamsToSave = sources.map((s) => ({
        ...s,
        mediaId,
        mediaType: type || normalizedType,
        title,
        year,
        expiresAt: new Date(Date.now() + THREE_DAYS_MS),
      }));

      const baseUrl = process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host || 'localhost'}`;
      const proxiedSources = sources.map((s) => {
        const payload = JSON.stringify({ url: s.url, headers: s.headers || { Referer: 'https://vidsrc.to/' } });
        return {
          ...s,
          url: `${baseUrl}/v1/proxy?data=${encodeURIComponent(payload)}`,
        };
      });

      await Promise.allSettled([
        Database.saveStreams(streamsToSave),
        StreamCache.set(mediaId, proxiedSources, THREE_DAYS_SECONDS),
      ]);

      return reply.send({ status: 'success', sources: proxiedSources, from: 'scraper_api_fresh' });
    } finally {
      await StreamCache.releaseScrapeLock(mediaId);
    }
  } catch (error) {
    console.error('Stream Fetch Error:', error);
    return reply.status(500).send({ error: 'System overloaded. Please try again.' });
  }
}

export async function saveScrapedLinks(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as any;
  const mediaId = String(body?.mediaId ?? '');
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  const mediaType = body?.mediaType;
  const title = body?.title;
  const year = body?.year;

  if (!mediaId || sources.length === 0) {
    return reply.status(400).send({ error: 'Missing required fields: mediaId, sources' });
  }

  try {
    const streamRecords = sources.map((source: any) => ({
      ...source,
      mediaId,
      mediaType,
      title,
      year,
      expiresAt: new Date(Date.now() + THREE_DAYS_MS),
      working: true,
    }));

    await Promise.allSettled([
      Database.saveStreams(streamRecords),
      StreamCache.set(mediaId, streamRecords, THREE_DAYS_SECONDS),
    ]);

    await StreamCache.releaseScrapeLock(mediaId);

    return reply.send({ success: true, mediaId, cached: streamRecords.length });
  } catch (error) {
    console.error('Save Scraped Links Error:', error);
    return reply.status(500).send({ success: false, error: 'Failed to save scraped links' });
  }
}

export async function reportDeadLink(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as any;
  const mediaId = String(body?.mediaId ?? '');
  const streamId = String(body?.streamId ?? '');

  if (!streamId) {
    return reply.status(400).send({ error: 'streamId is required' });
  }

  try {
    await Database.markBroken(streamId);
    if (mediaId) {
      await StreamCache.del(mediaId);
    }

    return reply.send({ status: 'purged', message: 'Cache cleared, next request will rescrape.' });
  } catch (error) {
    console.error('Report Dead Link Error:', error);
    return reply.status(500).send({ error: 'Failed to process report' });
  }
}

function normalizeMediaType(type?: string): string {
  if (!type) {
    return 'movie';
  }

  const lowered = type.toLowerCase();
  if (lowered === 'movies' || lowered === 'movie') {
    return 'movie';
  }

  if (lowered === 'series' || lowered === 'tv' || lowered === 'show') {
    return 'tv';
  }

  return lowered;
}

function parseSources(html: string, providerUrl: string): StreamSource[] {
  const $ = cheerio.load(html);
  const links: StreamSource[] = [];

  $('[data-config], [data-src], source, video').each((_, el) => {
    const url = $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
    if (url) {
      const finalUrl = url.startsWith('//') ? `https:${url}` : url;
      if (finalUrl.includes('m3u8') || finalUrl.includes('mp4') || finalUrl.includes('googlevideo')) {
        links.push({
          url: finalUrl,
          quality: 'Auto',
          source: 'VidSrc (HTML)',
          priority: 1,
          headers: { Referer: 'https://vidsrc.to/' },
        });
      }
    }
  });

  const fileRegex = /(?:file|url|src)["']?\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/g;
  let match;
  while ((match = fileRegex.exec(html)) !== null) {
    const url = match[1].replace(/\\/g, '');
    if (!links.some((l) => l.url === url)) {
      links.push({
        url,
        quality: 'Auto',
        source: 'VidSrc (Extracted)',
        priority: 2,
        headers: { Referer: 'https://vidsrc.to/' },
      });
    }
  }

  return links;
}
