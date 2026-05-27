/**
 * ScraperAPI integration utility.
 *
 * Routes fetch requests through ScraperAPI's proxy endpoint so that
 * all outbound scraping traffic uses rotating IPs.
 *
 * Set the SCRAPER_API_KEY environment variable to enable proxying.
 * When the key is absent the utility falls back to a direct fetch.
 */

const SCRAPER_API_BASE = 'https://api.scraperapi.com/';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ScraperApiOptions {
    /** Override the default 30-second request timeout (milliseconds). */
    timeoutMs?: number;
    /** Extra ScraperAPI query parameters, e.g. `{ render: 'true' }`. */
    scraperParams?: Record<string, string>;
}

/**
 * Perform an HTTP request, optionally routing it through ScraperAPI.
 *
 * @param url     - The target URL to fetch.
 * @param init    - Standard fetch options (method, headers, body, …).
 * @param options - ScraperAPI-specific options.
 * @returns The raw `Response` object.
 */
export async function scraperFetch(
    url: string,
    init: RequestInit = {},
    options: ScraperApiOptions = {}
): Promise<Response> {
    const apiKey = process.env.SCRAPER_API_KEY;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout((): void => controller.abort(), timeoutMs);

    // Merge caller's signal with our timeout signal when possible.
    // If the caller already passed a signal we honour both.
    const signal =
        init.signal instanceof AbortSignal
            ? anySignal([init.signal, controller.signal])
            : controller.signal;

    try {
        if (!apiKey) {
            // No API key — direct fetch
            return await fetch(url, { ...init, signal });
        }

        // Build the ScraperAPI endpoint URL
        const proxyUrl = new URL(SCRAPER_API_BASE);
        proxyUrl.searchParams.set('api_key', apiKey);
        proxyUrl.searchParams.set('url', url);

        if (options.scraperParams) {
            for (const [k, v] of Object.entries(options.scraperParams)) {
                proxyUrl.searchParams.set(k, v);
            }
        }

        // ScraperAPI does not support forwarding arbitrary request bodies
        // for GET/HEAD requests, so we strip the body in those cases.
        const method = (init.method ?? 'GET').toUpperCase();
        const body =
            method === 'GET' || method === 'HEAD' ? undefined : init.body;

        return await fetch(proxyUrl.toString(), {
            ...init,
            method,
            body,
            signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetch a URL and return the response body as text.
 * Returns `null` on network error or non-OK status.
 */
export async function scraperFetchText(
    url: string,
    init: RequestInit = {},
    options: ScraperApiOptions = {}
): Promise<string | null> {
    try {
        const response = await scraperFetch(url, init, options);
        if (!response.ok) {
            console.warn(
                `[scraperApi] Non-OK response ${response.status} for ${url}`
            );
            return null;
        }
        return await response.text();
    } catch (error) {
        console.error(
            `[scraperApi] scraperFetchText error: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

/**
 * Fetch a URL and parse the response body as JSON.
 * Returns `null` on network error, non-OK status, or JSON parse failure.
 */
export async function scraperFetchJson<T = unknown>(
    url: string,
    init: RequestInit = {},
    options: ScraperApiOptions = {}
): Promise<T | null> {
    try {
        const response = await scraperFetch(url, init, options);
        if (!response.ok) {
            console.warn(
                `[scraperApi] Non-OK response ${response.status} for ${url}`
            );
            return null;
        }
        return (await response.json()) as T;
    } catch (error) {
        console.error(
            `[scraperApi] scraperFetchJson error: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

/**
 * Combine multiple AbortSignals so that aborting any one of them aborts
 * the returned signal.  Falls back gracefully when `AbortSignal.any` is
 * not available (Node < 20).
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
    // Node 20+ ships AbortSignal.any()
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(signals);
    }

    const controller = new AbortController();

    const onAbort = (): void => {
        controller.abort();
        for (const s of signals) {
            s.removeEventListener('abort', onAbort);
        }
    };

    for (const s of signals) {
        if (s.aborted) {
            controller.abort();
            break;
        }
        s.addEventListener('abort', onAbort);
    }

    return controller.signal;
}
