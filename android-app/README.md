# CinePro Mobile (Kotlin)

This is a minimal Android app scaffold that embeds basic CinePro scraping logic locally, plays streams with ExoPlayer, supports playback speed control and downloading, and uploads scraped metadata to Supabase via WorkManager.

Quick start

1. Open this folder in Android Studio (`android-app`) and let it sync Gradle.
2. Provide Supabase credentials as environment variables for the WorkManager upload worker, or modify `CacheUploadWorker` to use BuildConfig values.
3. Run on a device (required for network and ExoPlayer).

Notes

- The scraping logic in `ScraperManager` is intentionally minimal and uses JSoup and a regex to find `.m3u8` and `.mp4` links. Port full CinePro provider logic incrementally.
- Storing or streaming copyrighted content may require permissions and compliance. Use responsibly.
