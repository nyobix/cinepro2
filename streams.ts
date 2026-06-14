import { Request, Response } from 'express';
import { StreamCache } from './StreamCache';
import { Database } from './Database';
import axios from 'axios';
import * as cheerio from 'cheerio';

const THREE_DAYS_SECONDS = 259200;
const THREE_DAYS_MS = THREE_DAYS_SECONDS * 1000;

export async function getStream(req: Request, res: Response) {
  const { mediaId } = req.params;
  const { title, year, type } = req.query;

  try {
    if (!mediaId) return res.status(400).json({ error: 'Media ID required' });

    // 1. Check Redis (Hot Cache - Primary layer for 10k user scalability)
    const cachedLinks = await StreamCache.get(mediaId);
    if (Array.isArray(cachedLinks) && cachedLinks.length > 0) {
      return res.json({ status: 'success', sources: cachedLinks, source: 'cache_hot' });
    }

    // 2. Check Supabase (Fallback layer - Persistent storage)
    const dbLinks = await Database.getValidStreams(mediaId);
    if (Array.isArray(dbLinks) && dbLinks.length > 0) {
      // Hydrate Redis so subsequent hits for this movie are instant
      await StreamCache.set(mediaId, dbLinks, THREE_DAYS_SECONDS);
      return res.json({ status: 'success', sources: dbLinks, source: 'database_persistent' });
    }

    // 3. Not in DB - Check if someone else is already scraping it
    const inProgress = await StreamCache.isScrapeInProgress(mediaId);
    if (inProgress) {
      return res.status(202).json({
        status: 'pending',
        message: 'This movie is being prepared by another user. Please wait a few seconds...'
      });
    }

    // 4. No one is scraping - Acquire lock and use Scraper API
    // This prevents multiple users from wasting Scraper API credits on the same movie
    const hasLock = await StreamCache.acquireScrapeLock(mediaId);
    if (!hasLock) {
      return res.status(202).json({ 
        status: 'pending', 
        message: 'Scrape in progress by another user. Please retry in 5 seconds.' 
      });
    }

    try {
      // Use the provided Scraper API key to bypass Cloudflare and IP restrictions
      const SCRAPER_KEY = 'e57edf0bdd17ac7aa7b2c31a67f98bc5';
      // Normalize type for vidsrc (movie/tv)
      const normalizedType = type === 'movies' ? 'movie' : type === 'series' ? 'tv' : type;
      const targetUrl = `https://vidsrc.to/embed/${normalizedType}/${mediaId}`;
      
      console.log(`🚀 Triggering ScraperAPI for: ${targetUrl}`);
      const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&keep_headers=true&cb=${Date.now()}`;
      
      const response = await axios.get(scraperUrl, { timeout: 30000 });
      const sources = parseSources(response.data, targetUrl); 
      if (sources && sources.length > 0) {
        const streamsToSave = sources.map(s => ({
          ...s,
          mediaId,
          mediaType: type,
          title,
          year,
          expiresAt: new Date(Date.now() + THREE_DAYS_MS)
        }));

        // Parallel save to both Database and Redis. 
        // allSettled ensures we return the stream even if one storage layer is slow.
        await Promise.allSettled([
          Database.saveStreams(streamsToSave),
          StreamCache.set(mediaId, sources, THREE_DAYS_SECONDS)
        ]);
        
        return res.json({ status: 'success', sources, from: 'scraper_api_fresh' });
      }

      return res.status(404).json({ error: 'No streams found via Scraper API' });
    } finally {
      // Always release the lock
      await StreamCache.releaseScrapeLock(mediaId);
    }

  } catch (error) {
    console.error('Stream Fetch Error:', error);
    res.status(500).json({ error: 'System overloaded. Please try again.' });
  }
}

function parseSources(html: string, providerUrl: string) {
  const $ = cheerio.load(html);
  const links: any[] = [];
  
  // 1. Look for sources in common player attributes and data tags
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
          headers: { "Referer": "https://vidsrc.to/" } // Hardcoded referer is often safer
        });
      }
    }
  });

  // 2. Regex extraction for JS-hidden links (Scraper API Rendered Content)
  const fileRegex = /(?:file|url|src)["']?\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/g;
  let match;
  while ((match = fileRegex.exec(html)) !== null) {
    const url = match[1].replace(/\\/g, ''); // Unescape slashes
    if (!links.some(l => l.url === url)) {
      links.push({
        url,
        quality: 'Auto',
        source: 'VidSrc (Extracted)',
        priority: 2,
        headers: { "Referer": "https://vidsrc.to/" }
      });
    }
  }

  return links;
}

/**
 * Called by the frontend/extension once scraping is finished
 */
export async function saveScrapedLinks(req: Request, res: Response) {
  const { mediaId, sources, mediaType, title, year } = req.body;

  try {
    // Save to Supabase permanently
    await Database.saveStreams(sources.map((s: any) => ({
      ...s,
      mediaId,
      expiresAt: new Date(Date.now() + THREE_DAYS_MS)
    })));

    // Cache in Redis for 3 days (259,200 seconds)
    await StreamCache.set(mediaId, sources, THREE_DAYS_SECONDS);

    // Release the lock so others can see the data
    await StreamCache.releaseScrapeLock(mediaId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
}

/**
 * Self-healing: If a user reports a dead link, we purge it
 */
export async function reportDeadLink(req: Request, res: Response) {
  const { mediaId, streamId } = req.body;

  try {
    // Delete from DB and Cache
    await Database.markBroken(streamId);
    await StreamCache.del(mediaId);

    res.json({ status: 'purged', message: 'Cache cleared, next request will rescrape.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process report' });
  }
}