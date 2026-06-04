import { Request, Response } from 'express';
import { StreamCache } from '../../cache/StreamCache';
import { Database } from '../../db/Database';

export async function getStream(req: Request, res: Response) {
  const { mediaId } = req.params;
  const mediaInfo = req.query; // { title, year, type }

  try {
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

    // 4. No one is scraping - Try to acquire the lock
    const locked = await StreamCache.acquireScrapeLock(mediaId);
    if (!locked) {
      return res.status(202).json({ status: 'pending', message: 'Scrape started elsewhere.' });
    }

    // 5. Trigger Scraper (Hybrid Extension or Server-side API)
    // We return a specialized status to the frontend to trigger the extension
    return res.status(404).json({
      status: 'scrape_required',
      action: 'TRIGGER_EXTENSION_OR_API',
      mediaId,
      payload: mediaInfo
    });

  } catch (error) {
    console.error('Stream Fetch Error:', error);
    res.status(500).json({ error: 'System overloaded. Please try again.' });
  }
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

    // Cache in Redis for 3 days
    await StreamCache.set(mediaId, sources);

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