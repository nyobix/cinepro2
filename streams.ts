import { Request, Response } from 'express';
import { StreamCache } from './StreamCache';
import { Database } from './Database';
import axios from 'axios';
import * as cheerio from 'cheerio';

export async function getStream(req: Request, res: Response) {
  const { mediaId } = req.params;
  const { title, year, type } = req.query;

  try {
    if (!mediaId) return res.status(400).json({ error: 'Media ID required' });

    // 1. Check Redis (Hot Cache - 3 days)
    const cachedLinks = await StreamCache.get(mediaId);
    if (cachedLinks) {
      return res.json({ status: 'success', sources: cachedLinks, from: 'cache' });
    }

    // 2. Check Supabase (Permanent Storage)
    const dbLinks = await Database.getValidStreams(mediaId);
    if (dbLinks && dbLinks.length > 0) {
      // Hydrate Redis for the next user
      await StreamCache.set(mediaId, dbLinks);
      return res.json({ status: 'success', sources: dbLinks, from: 'database' });
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
      // Use the Scraper API key from your Railway vars to bypass Cloudflare/IP bans
      const targetUrl = `https://vidsrc.to/embed/${type}/${mediaId}`;
      const scraperUrl = `https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true`;
      
      const response = await axios.get(scraperUrl, { timeout: 30000 });
      const sources = parseSources(response.data); 

      if (sources && sources.length > 0) {
        const streamsToSave = sources.map(s => ({
          ...s,
          mediaId,
          mediaType: type,
          title,
          year,
          expiresAt: new Date(Date.now() + 3600000) // Links expire in 1 hour
        }));

        // Parallel save for efficiency. 
        // Cache TTL is set to 3600s (1 hour) to match link expiration.
        await Promise.all([
          Database.saveStreams(streamsToSave),
          StreamCache.set(mediaId, sources, 3600)
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

function parseSources(html: string) {
  const $ = cheerio.load(html);
  const links: any[] = [];
  
  // Logic to find streaming links in the DOM
  $('a[href*="m3u8"], source[src*="m3u8"]').each((_, el) => {
    const url = $(el).attr('href') || $(el).attr('src');
    if (url) {
      links.push({
        url,
        quality: 'Auto',
        source: 'VidSrc',
        priority: 1
      });
    }
  });

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
      expiresAt: new Date(Date.now() + 3600000) // 1 hour link validity
    })));

    // Cache in Redis for 1 hour to match link expiration
    await StreamCache.set(mediaId, sources, 3600);

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