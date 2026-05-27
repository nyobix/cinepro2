/**
 * Scraper API wrapper for rotating IPs
 * Routes all scraping requests through Scraper API to ensure IP rotation
 */

interface ScraperApiOptions {
    apiKey: string;
    timeout?: number;
    retries?: number;
}

interface ScraperApiRequest {
    url: string;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: string;
}

interface ScraperApiResponse {
    statusCode: number;
    body: string;
    headers?: Record<string, string>;
}

export class ScraperApiClient {
    private apiKey: string;
    private timeout: number;
    private retries: number;
    private readonly SCRAPER_API_URL = 'http://api.scraperapi.com';

    constructor(options: ScraperApiOptions) {
        this.apiKey = options.apiKey;
        this.timeout = options.timeout ?? 30000;
        this.retries = options.retries ?? 3;

        if (!this.apiKey) {
            throw new Error('SCRAPER_API_KEY environment variable is required');
        }
    }

    /**
     * Make a request through Scraper API with automatic IP rotation
     */
    async fetch(request: ScraperApiRequest): Promise<ScraperApiResponse> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < this.retries; attempt++) {
            try {
                const response = await this.makeRequest(request, attempt);
                return response;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                
                // Exponential backoff: 1s, 2s, 4s
                if (attempt < this.retries - 1) {
                    const delay = Math.pow(2, attempt) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError || new Error('Failed to fetch through Scraper API after retries');
    }

    /**
     * Make a single request to Scraper API
     */
    private async makeRequest(
        request: ScraperApiRequest,
        attempt: number
    ): Promise<ScraperApiResponse> {
        const params = new URLSearchParams({
            api_key: this.apiKey,
            url: request.url,
            // Use different render engines on retries for better success rate
            render: attempt > 0 ? 'true' : 'false'
        });

        const scraperUrl = `${this.SCRAPER_API_URL}?${params.toString()}`;

        const fetchOptions: RequestInit = {
            method: request.method ?? 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...request.headers
            },
            timeout: this.timeout
        };

        if (request.body && (request.method === 'POST')) {
            fetchOptions.body = request.body;
        }

        const response = await fetch(scraperUrl, fetchOptions);

        if (!response.ok) {
            throw new Error(
                `Scraper API returned ${response.status}: ${response.statusText}`
            );
        }

        const body = await response.text();

        return {
            statusCode: response.status,
            body,
            headers: Object.fromEntries(response.headers.entries())
        };
    }

    /**
     * Fetch and parse JSON through Scraper API
     */
    async fetchJson<T = unknown>(request: ScraperApiRequest): Promise<T> {
        const response = await this.fetch(request);
        try {
            return JSON.parse(response.body) as T;
        } catch (error) {
            throw new Error(
                `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

/**
 * Create a singleton Scraper API client
 */
let scraperApiClient: ScraperApiClient | null = null;

export function getScraperApiClient(): ScraperApiClient {
    if (!scraperApiClient) {
        scraperApiClient = new ScraperApiClient({
            apiKey: process.env.SCRAPER_API_KEY || '',
            timeout: 30000,
            retries: 3
        });
    }
    return scraperApiClient;
}

