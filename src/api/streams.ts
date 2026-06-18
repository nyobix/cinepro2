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
  provider?: {
    id: string;
    name: string;
  };
  priority?: number;
  headers?: Record<string, string>;
}

interface ProxyPayload {
  url: string;
  headers?: Record<string, string>;
}

function createProvider(sourceName: string): { id: string; name: string } {
  const name = sourceName?.trim() || 'Unknown';
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    name,
  };
}

function wrapProxySource(source: StreamSource, baseUrl: string, defaultHeaders: Record<string, string>): StreamSource {
  if (!source?.url) return source;
  if (source.url.includes('/v1/proxy?data=')) return source;
  const payload = JSON.stringify({ url: source.url, headers: source.headers || defaultHeaders });
  return {
    ...source,
    provider: source.provider || createProvider(source.source),
    url: `${baseUrl}/v1/proxy?data=${encodeURIComponent(payload)}`,
  };
}

function filterHeaders(headers: Record<string, any>) {
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
  ]);
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (!key) return acc;
    const lowerKey = key.toLowerCase();
    if (hopByHop.has(lowerKey)) return acc;
    if (value === undefined || value === null) return acc;
    acc[key] = Array.isArray(value) ? value.join(',') : String(value);
    return acc;
  }, {} as Record<string, string>);
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
      return reply.send({ status: 'success', data: { sources: cachedLinks }, source: 'cache_hot' });
    }

    const dbLinks = await Database.getValidStreams(mediaId);
    if (Array.isArray(dbLinks) && dbLinks.length > 0) {
      const baseUrl = process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host || 'localhost'}`;
      const proxiedLinks = dbLinks.map((link: StreamSource) => wrapProxySource(link, baseUrl, { Referer: 'https://vidsrc.to/' }));
      await StreamCache.set(mediaId, proxiedLinks, THREE_DAYS_SECONDS);
      return reply.send({ status: 'success', data: { sources: proxiedLinks }, source: 'database_persistent' });
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

      const scraperProvider = (process.env.SCRAPER_PROVIDER || 'vixsrc').toLowerCase();
      const providerBaseUrl =
        scraperProvider === 'vidsrc' ? 'https://vsembed.ru' : 'https://vixsrc.to';
      const providerName = scraperProvider === 'vidsrc' ? 'VidSrc' : 'VixSrc';
      const providerReferer = providerBaseUrl;
      const providerNestedDomains =
        scraperProvider === 'vidsrc'
          ? ['vsembed.ru', 'vidsrc.to']
          : ['vixsrc.to'];

      const normalizedType = normalizeMediaType(type);
      const targetUrl =
        `${providerBaseUrl}/embed/${normalizedType}?tmdb=${mediaId}` +
        (normalizedType === 'tv'
          ? `&season=${query.season || query.s || ''}&episode=${query.episode || query.e || ''}`
          : '');
      console.log(`Triggering Scraper API for ${targetUrl}`);

      const scraperUrl = getScraperApiUrl(targetUrl, scraperKey);
      let response: any;
      try {
        response = await axios.get(scraperUrl, {
          timeout: 45000,
          headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          },
        });
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

      const sources = await parseSources(
        response.data,
        targetUrl,
        scraperKey,
        providerName,
        providerReferer,
        providerNestedDomains
      );

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
        const payload = JSON.stringify({ url: s.url, headers: s.headers || { Referer: providerReferer } });
        return {
          ...s,
          url: `${baseUrl}/v1/proxy?data=${encodeURIComponent(payload)}`,
        };
      });

      await Promise.allSettled([
        Database.saveStreams(streamsToSave),
        StreamCache.set(mediaId, proxiedSources, THREE_DAYS_SECONDS),
      ]);

      return reply.send({ status: 'success', data: { sources: proxiedSources }, from: 'scraper_api_fresh' });
    } finally {
      await StreamCache.releaseScrapeLock(mediaId);
    }
  } catch (error) {
    console.error('Stream Fetch Error:', error);
    return reply.status(500).send({ error: 'System overloaded. Please try again.' });
  }
}

export async function proxyStream(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, string | undefined>;
  const data = query.data;

  if (!data) {
    return reply.status(400).send({ error: 'Missing proxy data payload' });
  }

  let payload: ProxyPayload;
  try {
    payload = JSON.parse(decodeURIComponent(data));
  } catch (error) {
    return reply.status(400).send({ error: 'Invalid proxy data payload' });
  }

  if (!payload.url) {
    return reply.status(400).send({ error: 'Proxy payload missing url' });
  }

  try {
    const response = await axios.get(payload.url, {
      responseType: 'stream',
      headers: {
        ...filterHeaders(payload.headers || {}),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      },
      timeout: 45000,
    });

    reply.headers(response.headers as any);
    return reply.send(response.data);
  } catch (error: any) {
    console.error('[Proxy] Failed to fetch proxied URL', payload.url, error?.message || error);
    return reply.status(502).send({ error: 'Failed to proxy stream URL', details: error?.message });
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

async function parseSources(
  html: string,
  providerUrl: string,
  scraperKey: string | undefined,
  providerName: string,
  providerReferer: string,
  providerNestedDomains: string[]
): Promise<StreamSource[]> {
  const $ = cheerio.load(html);
  const links: StreamSource[] = [];

  const pushLink = (url: string, source: string, priority = 1) => {
    const finalUrl = normalizeUrl(url, providerUrl);
    if (!finalUrl) return;
    if (!isStreamUrl(finalUrl)) return;
    if (links.some((l) => l.url === finalUrl)) return;

    links.push({
      url: finalUrl,
      quality: 'Auto',
      source,
      priority,
      headers: { Referer: providerReferer },
    });
  };

  const scanHtml = (content: string) => {
    const inner$ = cheerio.load(content);

    inner$('[data-config], [data-src], source, video').each((_, el) => {
      const attrs = ['data-src', 'data-config', 'src', 'href'];
      for (const attr of attrs) {
        const value = inner$(el).attr(attr);
        if (!value) continue;

        if (attr === 'data-config') {
          extractJsonUrls(value).forEach((url) => pushLink(url, `${providerName} (JSON)`, 1));
        } else {
          pushLink(value, `${providerName} (HTML)`, 1);
        }
      }
    });

    const inlineText = inner$('script').toArray().map((el) => inner$(el).html() || '').join('\n');
    extractUrlsFromText(inlineText).forEach((url) => pushLink(url, `${providerName} (Script)`, 2));
    extractUrlsFromText(content).forEach((url) => pushLink(url, `${providerName} (Text)`, 3));
    extractStreamUrlsFromText(inlineText).forEach((url) => pushLink(url, `${providerName} (Stream JS)`, 1));
    extractStreamUrlsFromText(content).forEach((url) => pushLink(url, `${providerName} (Stream HTML)`, 2));
  };

  scanHtml(html);

  if (links.length === 0 && scraperKey) {
    const iframeUrls = $('iframe[src]').toArray().map((el) => $(el).attr('src')).filter(Boolean) as string[];
    const nestedCandidates = iframeUrls
      .map((src) => normalizeUrl(src, providerUrl))
      .filter(Boolean) as string[];

    for (const nested of nestedCandidates) {
      if (!providerNestedDomains.some((domain) => nested.includes(domain))) {
        continue;
      }

      try {
        console.warn('[Streams] Following nested iframe for', nested);
        const nestedUrl = getScraperApiUrl(nested, scraperKey);
        const nestedResponse = await axios.get(nestedUrl, {
          timeout: 45000,
          headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          },
        });
        scanHtml(String(nestedResponse.data));
      } catch (err: any) {
        console.warn('[Streams] Nested iframe fetch failed for', nested, err?.message || err);
      }
    }
  }

  return links;
}

function normalizeUrl(url: string, baseUrl: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

function isStreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('.mp4') || lower.includes('googlevideo');
}

function extractJsonUrls(str: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = JSON.parse(str.replace(/\s+/g, ' '));
    collectUrls(parsed, urls);
  } catch {
    // ignore invalid JSON, fallback to text parsing
    extractUrlsFromText(str).forEach((url) => urls.push(url));
  }
  return urls;
}

function collectUrls(value: any, out: string[]) {
  if (typeof value === 'string') {
    if (isStreamUrl(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, out));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((item) => collectUrls(item, out));
  }
}

function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  const regex = /https?:\/\/[^"'\s]+?(?:\.m3u8|\.mp4|\.mkv|googlevideo[^"'\s]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    urls.push(match[0].replace(/\\/g, ''));
  }
  return urls;
}

function extractStreamUrlsFromText(text: string): string[] {
  const decoded = decodeEscapedText(text);
  const urls = new Set<string>();

  extractUrlsFromText(decoded).forEach((url) => urls.add(url));

  const pattern = /(?:file|src|hls|url|manifest|playlist)\s*[:=]\s*["']([^"']+?(?:\.m3u8|\.mp4))["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(decoded)) !== null) {
    urls.add(match[1].replace(/\\/g, ''));
  }

  const jsonLike = /\{[^}]*?(?:\.m3u8|\.mp4)[^}]*?\}/gi;
  while ((match = jsonLike.exec(decoded)) !== null) {
    extractUrlsFromText(match[0]).forEach((url) => urls.add(url));
  }

  return Array.from(urls);
}

function decodeEscapedText(text: string): string {
  return text
    .replace(/\\\\/g, '\\')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\x3d/g, '=')
    .replace(/\\x26/g, '&');
}

function getScraperApiUrl(targetUrl: string, scraperKey: string): string {
  const query = new URLSearchParams({
    api_key: scraperKey,
    url: targetUrl,
    render: 'true',
    keep_headers: 'true',
    wait_for: '10000',
    country_code: 'us',
    cb: String(Date.now()),
  });
  return `https://api.scraperapi.com?${query.toString()}`;
}
