import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Utility to route requests through Scraper API for rotating IPs.
 */
export async function scraperFetch<T = any>(
    url: string,
    options: AxiosRequestConfig = {}
): Promise<AxiosResponse<T>> {
    const apiKey = process.env.SCRAPER_API_KEY;
    const proxyEnabled = process.env.PROXY_ENABLED === 'true';

    if (!apiKey || !proxyEnabled) {
        if (proxyEnabled && !apiKey) {
            console.warn('[ScraperAPI] Proxy is enabled but SCRAPER_API_KEY is missing. Falling back to direct request.');
        }
        return axios.request<T>({ url, ...options });
    }

    const scraperUrl = 'https://api.scraperapi.com/';
    const proxyRotation = process.env.PROXY_ROTATION === 'true';
    
    const config: AxiosRequestConfig = {
        ...options,
        method: options.method ?? 'GET',
        params: {
            ...options.params,
            api_key: apiKey,
            url: url,
            // Some ScraperAPI plans use specific flags for high-quality rotation
            premium: proxyRotation, 
        }
    };

    try {
        return await axios.request<T>({ ...config, url: scraperUrl });
    } catch (error: any) {
        console.error(`[ScraperAPI] Error fetching ${url}:`, error.message);
        throw error;
    }
}

export const scraperFetchText = (url: string, options?: AxiosRequestConfig) => 
    scraperFetch<string>(url, { ...options, responseType: 'text' });