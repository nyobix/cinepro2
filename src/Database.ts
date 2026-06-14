import { createClient, SupabaseClient } from '@supabase/supabase-js';

export class Database {
  private static client: SupabaseClient | null = null;

  static async init() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
      console.warn('[Database] Supabase is not configured. Database fallback will be disabled.');
      return;
    }

    this.client = createClient(url, key);
    console.info('[Database] Supabase client initialized');
  }

  static isEnabled(): boolean {
    return !!this.client;
  }

  static async saveStreams(records: any[]): Promise<any[]> {
    if (!this.client) {
      return records;
    }

    const normalized = records.map((record) => ({
      ...record,
      media_id: record.mediaId ?? record.media_id,
      media_type: record.mediaType ?? record.media_type,
      url: record.url,
      source: record.source,
      quality: record.quality ?? 'unknown',
      priority: record.priority ?? 0,
      working: record.working ?? true,
      expires_at: record.expiresAt ? new Date(record.expiresAt).toISOString() : new Date().toISOString(),
      title: record.title ?? null,
      year: record.year ?? null,
      metadata: record.metadata ?? null,
    }));

    const { data, error } = await this.client
      .from('streams')
      .upsert(normalized, { onConflict: 'media_id,source,url' })
      .select();

    if (error) {
      console.error('[Database] Save streams failed:', error.message || error);
      throw error;
    }

    return data || [];
  }

  static async getValidStreams(mediaId: string, quality?: string): Promise<any[]> {
    if (!this.client) {
      return [];
    }

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

    if (error) {
      console.error('[Database] Get valid streams failed:', error.message || error);
      throw error;
    }

    return data || [];
  }

  static async markBroken(streamId: string): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    const { error } = await this.client
      .from('streams')
      .update({ working: false })
      .eq('id', streamId);

    if (error) {
      console.error('[Database] markBroken failed:', error.message || error);
      return false;
    }

    return true;
  }

  static async ping(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const { error } = await this.client.from('streams').select('id', { count: 'exact', head: true });
      return !error;
    } catch (error) {
      console.error('[Database] Ping failed:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
