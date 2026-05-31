import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_ROTATION = process.env.PROXY_ROTATION === 'true';

export async function scraperFetch<T = any>(
    url: string,
    options: AxiosRequestConfig = {}
): Promise<AxiosResponse<T>> {
    if (!PROXY_ENABLED || !SCRAPER_API_KEY) {
        return axios({ url, ...options });
    }

    const scraperUrl = 'https://api.scraperapi.com/';
    
    const config: AxiosRequestConfig = {
        ...options,
        url: scraperUrl,
        params: {
            ...options.params,
            api_key: SCRAPER_API_KEY,
            url: url,
            premium: PROXY_ROTATION,
        }
    };

    try {
        return await axios(config);
    } catch (error: any) {
        console.error(`[ScraperAPI] Error fetching ${url}:`, error.message);
        throw error;
    }
}

export async function scraperFetchText(url: string, options: AxiosRequestConfig = {}): Promise<string> {
    const response = await scraperFetch<string>(url, { ...options, responseType: 'text' });
    return response.data;
}

export async function scraperFetchJson<T = any>(url: string, options: AxiosRequestConfig = {}): Promise<T> {
    const response = await scraperFetch<T>(url, { ...options, responseType: 'json' });
    return response.data;
}