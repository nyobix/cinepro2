# CinePro Architecture: Hybrid Workflow

## Overview

CinePro operates on a hybrid architecture that combines a Railway backend with client-side browser extension scraping. This design enables scaling to 5,000+ free users while maintaining server security, minimizing costs, and ensuring lightning-fast performance.

## The Problem We Solve

**Traditional Centralized Scraping Fails at Scale:**
- Server IP gets banned instantly from streaming providers
- Hosting costs explode with server-side HTML parsing and Cloudflare bypass
- Cannot serve 5,000+ users without enterprise-level infrastructure
- Single point of failure

**Our Solution: Offload Scraping to Users**
- Railway handles data and caching only (zero scraping risk)
- Browser extensions handle risky scraping from user's home IP
- Cost: $0 for server infrastructure
- Performance: Lightning-fast cached responses
- Resilience: 5,000 residential IPs = can't be blocked

---

## The 5,000+ User Hybrid Workflow

### Step 1: Frontend Requests Cached Link

**When a user clicks "Play" on a movie:**

```
┌─────────────────────────────────────────────────────────────┐
│ User clicks "Play" on CinePro Web                            │
│ Frontend makes request to Railway backend:                   │
│ "Do we have a working stream link for Movie X?"              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
         Railway Backend (Database Check)
         ├─ Query: SELECT * FROM streams
         │  WHERE media_id = X
         │  AND expires_at > NOW()
         └─ Return: Link (if exists) or NULL
```

**Code Example (Frontend):**
```typescript
// 1. Check if link is cached
const cachedLink = await fetch(
  `${RAILWAY_API}/streams/${movieId}`
).then(r => r.json());

if (cachedLink?.url && !isExpired(cachedLink)) {
  // Play immediately - Cache Hit!
  startPlayback(cachedLink.url);
} else {
  // No cache - Time to scrape
  triggerBrowserExtension(movieId);
}
```

---

### Step 2a: Cache Hit (Fast Lane) ✅

**When the movie was already scraped recently:**

```
┌──────────────────────────────────────────────────────┐
│ Another user watched Movie X 20 minutes ago          │
│ That link is cached in Railway (expires in 40 min)   │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
    Railway Returns Cached m3u8
    ├─ Status: 200 OK
    ├─ Link: https://cdn.provider.com/video.m3u8
    ├─ Expires: 40 minutes
    └─ Source: Database (Supabase/Firebase)
               │
               ▼
    ┌──────────────────────────────┐
    │ Video Plays Instantly        │
    │ Zero scraping required       │
    │ Server IP stays safe         │
    │ No browser extension needed  │
    └──────────────────────────────┘
```

**Database Response:**
```json
{
  "id": "abc123",
  "mediaId": "movie_12345",
  "url": "https://cdn.streaming-provider.com/video.m3u8",
  "quality": "720p",
  "source": "provider_1",
  "expiresAt": "2026-05-25T14:30:00Z",
  "cachedAt": "2026-05-25T13:30:00Z",
  "ttl": 3600
}
```

**Benefits:**
- ⚡ Instant playback (database query < 100ms)
- 🛡️ No IP risk to Railway
- 🤝 No browser extension overhead
- 💰 Ultra-low server load

---

### Step 2b: Cache Miss (Time to Scrape) ❌

**When the movie isn't cached or link expired:**

```
┌──────────────────────────────────────────────────────┐
│ Movie not in cache OR link expired                    │
│ Railway responds: "No cached link available"          │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
    Frontend Triggers Browser Extension
    ├─ Sends: { movieId, title, year, type }
    └─ Extension receives request in background
```

---

### Step 3: Browser Extension Scrapes

**The extension runs in the user's browser:**

```
┌─────────────────────────────────────────────────────────┐
│ Browser Extension (Running as User)                      │
│ ├─ User's Home IP (residential)                         │
│ ├─ Browser cookies & headers                            │
│ └─ User-Agent: Regular browser                          │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
    Fetch Streaming Provider HTML
    ├─ URL: https://streaming-provider.com/movie/12345
    ├─ Headers: User's real browser headers
    ├─ Bypass: CORS (extension can access cross-origin)
    └─ Result: Raw HTML or API response
               │
               ▼
    Extract Stream Links
    ├─ Parse HTML/API response
    ├─ Find video URLs (m3u8, mp4, etc)
    ├─ Extract quality info
    └─ Result: Array of stream links
               │
               ▼
    ┌────────────────────────────────┐
    │ To streaming provider:          │
    │ "Looks like normal user browsing"
    │ ✓ Residential IP                │
    │ ✓ Real browser                  │
    │ ✓ Cookie support                │
    │ ✓ JavaScript rendering          │
    └────────────────────────────────┘
```

**Why Extension Bypasses Blocks:**

1. **User's Residential IP** - Provider sees millions of residential IPs, can't ban all
2. **Real Browser Headers** - Looks like a real person browsing
3. **Cookie Support** - Can store and send session cookies
4. **JavaScript Rendering** - Can wait for dynamic content to load
5. **CORS Bypass** - Extension can fetch cross-origin without CORS headers

---

### Step 4: Extension Returns Links to Frontend

**Extension sends results back to webpage:**

```
┌────────────────────────────────────────────────────────┐
│ Browser Extension                                       │
│ ├─ Extracted 5+ stream links                           │
│ ├─ Verified links work                                 │
│ └─ Returns to content script                           │
└──────────────┬─────────────────────────────────────────┘
               │
               ▼
    Frontend Receives Stream Array
    ├─ Link 1: https://cdn1.com/video.m3u8 (1080p)
    ├─ Link 2: https://cdn2.com/video.m3u8 (720p)
    ├─ Link 3: https://backup.com/video.mp4 (480p)
    └─ ... up to 50+ sources
               │
               ▼
    ┌─────────────────────────────┐
    │ User Can Now:               │
    │ ✓ Play immediately          │
    │ ✓ Choose quality/source     │
    │ ✓ Switch if link dies       │
    └─────────────────────────────┘
```

---

### Step 5: Frontend Updates Railway Cache

**The loop closes - cache is populated:**

```
┌────────────────────────────────────────────────────────┐
│ Frontend Updates Railway                               │
│ POST /api/streams                                       │
│ {                                                       │
│   "mediaId": "movie_12345",                             │
│   "title": "Movie Title",                               │
│   "sources": [                                          │
│     {                                                   │
│       "url": "https://cdn1.com/video.m3u8",             │
│       "quality": "1080p",                               │
│       "source": "provider_1",                           │
│       "priority": 1                                     │
│     },                                                  │
│     // ... more sources                                │
│   ],                                                    │
│   "expiresIn": 3600  // 1 hour TTL                      │
│ }                                                       │
└──────────────┬─────────────────────────────────────────┘
               │
               ▼
    Railway Backend
    ├─ Validate request
    ├─ Store in database (Supabase/Firebase)
    ├─ Set cache TTL: 1 hour
    └─ Response: { cached: true, expiresAt: ... }
               │
               ▼
    ┌──────────────────────────────────┐
    │ Cache Populated!                  │
    │ Next 4,999 users for this movie:  │
    │ ✓ Instant playback               │
    │ ✓ No browser extension needed    │
    │ ✓ Minimal server load            │
    └──────────────────────────────────┘
```

---

## Why This Setup Cannot Be Blocked

### 1. Distributed IP Pool
```
Traditional (BLOCKED):
Server IP: 203.0.113.42 ──X── Banned

Our System (UNBLOCKABLE):
User 1 IP: 192.0.2.1
User 2 IP: 192.0.2.2
User 3 IP: 192.0.2.3
...
User 5000 IP: 192.0.2.5000

With 5,000 users, providers see requests from 5,000 different residential IPs.
Blocking all residential IP ranges = blocking legitimate users 💥
```

### 2. Railway Acts as Shield
```
Request Flow:
User 1 scrapes (IP: 192.0.2.1) → Extracts link
User 1 → Railway (Cache) ← Returns link
User 2, 3, 4, 5... → Railway (Cache) ← All get cached link

Result: Popular movie only scraped once per hour
Other 4,999 users served from Railway cache instantly
```

### 3. Ultra-Low Server Load
```
Traditional Setup (Per Request):
Server processes:
├─ HTML parsing
├─ Cloudflare bypass
├─ Ad blocking
├─ JavaScript rendering
└─ Stream extraction
Cost: $100+/month for high CPU

Our Setup (Per Request):
Railway processes:
├─ Database query (< 1ms)
└─ Cache hit (< 100ms)
Cost: $0 (free tier covers 5,000+ users)
```

---

## System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                         CinePro Ecosystem                           │
└────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐        ┌──────────────────────┐
│  CinePro Web UI     │────────│  Browser Extension   │
│  (React/Vue)        │        │  (Content Script)    │
│                     │        │                      │
│ ✓ Display movies    │        │ ✓ Scrape providers   │
│ ✓ Play videos       │        │ ✓ Extract links      │
│ ✓ Manage streams    │        │ ✓ Bypass CORS        │
└──────────┬──────────┘        └─────────────┬────────┘
           │                                  │
           │ (1) Request link                 │ (4) Send links back
           │ from Railway                     │
           ▼                                  ▼
    ┌──────────────────────────────────────────────────────┐
    │          Railway Backend (CinePro Server)             │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │ HTTP Endpoints:                                 │ │
    │  │ ├─ GET /api/streams/:mediaId (Check cache)     │ │
    │  │ ├─ POST /api/streams (Save links)              │ │
    │  │ ├─ GET /omss/stream/:mediaId (OMSS API)        │ │
    │  │ └─ GET /healthz (Status check)                 │ │
    │  └─────────────────────────────────────────────────┘ │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │ Cache Layer (Redis/Memory):                     │ │
    │  │ ├─ Movie links: TTL 1-24 hours                  │ │
    │  │ ├─ Provider metadata: TTL 7 days                │ │
    │  │ └─ Search results: TTL 6 hours                  │ │
    │  └─────────────────────────────────────────────────┘ │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │ Database (Supabase/Firebase):                   │ │
    │  │ ├─ Streams table (links with TTL)              │ │
    │  │ ├─ Media metadata (movies/shows)               │ │
    │  │ └─ User preferences (if auth enabled)          │ │
    │  └─────────────────────────────────────────────────┘ │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │ External APIs:                                  │ │
    │  │ ├─ TMDB (Movie metadata)                       │ │
    │  │ ├─ MCP (AI Agent support)                      │ │
    │  │ └─ Stremio Addons (if configured)              │ │
    │  └─────────────────────────────────────────────────┘ │
    └──────┬───────────────────────────────┬──────────────┘
           │ (2) Return cached link         │ (5) Store fresh links
           │ if available                   │ with 1h TTL
           ▼                                ▼
    ┌────────────────────────────────────────────────────┐
    │     Database (Supabase/Firebase)                    │
    │     ┌──────────────────────────────────────────┐   │
    │     │ Streams Table:                           │   │
    │     │ ├─ id: abc123                            │   │
    │     │ ├─ mediaId: movie_12345                  │   │
    │     │ ├─ url: https://cdn.../video.m3u8       │   │
    │     │ ├─ quality: 1080p                        │   │
    │     │ ├─ expiresAt: 2026-05-25T14:30:00Z       │   │
    │     │ └─ source: provider_1                    │   │
    │     └──────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────┘

           ┌──────────────────────────────────┐
           │   Streaming Providers            │
           │   (Blocked to server)            │
           │                                  │
           │ ✗ Cannot block Railway IP        │
           │ ✓ Sees 5,000 user IPs instead   │
           │ ✓ Can't block all residential   │
           └──────────────────────────────────┘
```

---

## Key Technologies

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Backend** | Node.js + TypeScript | Runtime and type safety |
| **Cache** | Redis / Memory | Session and link caching |
| **Database** | Supabase / Firebase | Persistent storage |
| **Metadata** | TMDB API | Movie/show information |
| **Deployment** | Railway | Zero-cost infrastructure |
| **Browser Ext** | WebExtensions API | Client-side scraping |
| **Proxy** | Built-in proxy layer | URL extraction and caching |
| **AI Support** | MCP (Model Context Protocol) | AI agent compatibility |

---

## Configuration for 5,000+ Users

### Railway Environment Variables

```env
# Network
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=https://your-railway-deployment.railway.app

# Cache Strategy (critical for 5,000+ users)
CACHE_TYPE=redis  # Use Redis in production
REDIS_HOST=your-redis.railway.app
REDIS_PORT=6379
REDIS_PASSWORD=your-secure-password

# Cache TTLs
STREAM_CACHE_TTL=3600  # 1 hour for links
METADATA_CACHE_TTL=604800  # 7 days for metadata

# API Keys
TMDB_API_KEY=your_tmdb_key

# Database (Supabase Transaction Pooler)
# Port 6543 handles high concurrency for 5,000+ users. sslmode=require is mandatory for Supabase.
DATABASE_URL="postgresql://postgres.sfrrpkzplryewkkhxjyo:[PASSWORD]@aws-1-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require"

# CORS (Allow web UI origin)
CORS_ORIGIN=https://your-frontend-domain.com,http://localhost:3000

# Optional Features
STREMIO_ADDON=false  # Enable Stremio compatibility
MCP_ENABLED=true   # Enable AI agent support
```

### Database Schema (Supabase)

```sql
-- Streams table (cached links)
CREATE TABLE streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id VARCHAR NOT NULL,
  media_type ENUM('movie', 'tv') NOT NULL,
  url TEXT NOT NULL,
  quality VARCHAR,
  source VARCHAR NOT NULL,
  priority INT DEFAULT 0,
  working BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(media_id, source, url)
);

CREATE INDEX idx_streams_media_id ON streams(media_id);
CREATE INDEX idx_streams_expires_at ON streams(expires_at);

-- Media metadata
CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id INT UNIQUE NOT NULL,
  type ENUM('movie', 'tv') NOT NULL,
  title VARCHAR NOT NULL,
  year INT,
  poster_url TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_media_tmdb_id ON media(tmdb_id);
```

---

## Cost Analysis for 5,000 Users

### Traditional Centralized Scraping
```
Compute:        $150/month (high CPU for parsing)
Database:       $50/month
Bandwidth:      $200/month (heavy HTML transfer)
IP Proxies:     $500+/month (trying to stay alive)
Support:        $100/month (IP bans, troubleshooting)
─────────────────────────────
Total:          $1,000+/month ❌
Scaling factor: Doubles with every 1,000 users
```

### CinePro Hybrid Workflow
```
Railway:        $0/month (free tier: 500 hours/month)
Database:       $0/month (Supabase free tier)
Bandwidth:      ~$5/month (minimal JSON responses)
Browser Ext:    $0 (distributed scraping)
Support:        $0 (no IP issues)
─────────────────────────────
Total:          $5/month ✅
Scaling factor: Fixed cost until 5,000+ users
```

---

## Failure Scenarios & Recovery

### Scenario 1: Single Provider Gets Blocked
**Problem:** Provider bans links from certain IP ranges

**Solution:**
- Other users' IPs can still scrape
- Cache continues serving existing links for 1 hour
- Next scrape attempt uses different user IP
- No single point of failure

### Scenario 2: Link Expires During Playback
**Problem:** Video link dies mid-stream

**Solution:**
- Frontend detects: 403/404 response
- Requests new link from Railway
- Cache miss → triggers extension scraping again
- Seamless retry with different source

### Scenario 3: Railway Goes Down
**Problem:** Backend unavailable

**Solution:**
- Browser extension still works (scrapes directly)
- Links cached in browser can be used offline
- Service recovers quickly (Railway reliability: 99.9%)
- No data loss (persistent database)

### Scenario 4: TMDB API Rate Limited
**Problem:** Metadata API quota exceeded

**Solution:**
- Response cached for 7 days
- Works offline with cached metadata
- Graceful degradation (use previous data)
- Rate limit resets daily

---

## Future Enhancements

### Phase 2: User Accounts & Profiles
- Store preferred quality settings
- Watch history
- Custom watchlists
- Subtitle preferences

### Phase 3: Family Sharing
- Multiple user profiles
- Parental controls
- Shared watchlist
- Device sync

### Phase 4: CineHome Integration
- Download automation
- Batch processing
- Local library management
- Offline playback

### Phase 5: Advanced Analytics
- Popular searches
- Trending content
- Provider performance metrics
- User engagement insights

---

## Conclusion

The hybrid workflow is **THE** solution for sustainable, scalable streaming aggregation:

✅ **No IP bans** - Distributed residential IPs
✅ **Zero cost** - $0 server infrastructure
✅ **Lightning fast** - Cached responses < 100ms
✅ **Unblockable** - Cannot ban 5,000 residential IPs
✅ **Resilient** - Multiple fallbacks and retries
✅ **Future-proof** - Scales to 50,000+ users

Railway handles the "brain" (caching & metadata), while users collectively handle scraping through their browser extensions. Together: **Unstoppable.**
