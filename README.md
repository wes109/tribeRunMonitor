# Tribe Monitor

A monitoring tool that tracks new tribe creations on tribe.run and validates creator Twitter metrics.

![Example](https://github.com/user-attachments/assets/768079ed-ff0b-469f-9cfc-490836ffc154)


## Setup

1. Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

2. Install dependencies:
```bash
bun install
```

3. Create a `proxy.txt` file with your proxies (one per line):
```
username:password@host:port
```

4. Create a `.env` file with your Discord webhook:
```
DISCORD_WEBHOOK_URL=your_discord_webhook_url
```

## Configuration

The monitor can be configured in `monitor.ts`:

- `REQUEST_INTERVAL`: Time between checks (default: 250ms)
- `MIN_FOLLOWERS`: Minimum Twitter followers to trigger alert
- `WATCHLIST`: Array of important names to watch for (case insensitive)

## Running

Start the monitor:
```bash
bun run monitor.ts
```

## How It Works

1. Monitors tribe.run for new tribe creations
2. When a new tribe is created:
   - Checks creator's Twitter follower count
   - Validates against minimum follower threshold
   - Checks if creator is on watchlist
3. Sends Discord notification if:
   - Creator has > 10k followers
   - Creator name matches watchlist
4. Features:
   - Proxy rotation for avoiding rate limits
   - Automatic session refresh
   - No Twitter authentication required
   - Real-time monitoring

## Known Issues & Solutions

### Tribe.run API Rate Limiting
**Issue:** The Tribe.run API returns 400 errors after multiple requests from the same session.

**Solution:** The monitor automatically:
- Detects consecutive API failures
- Rotates to a new proxy
- Creates fresh browser session
- Continues monitoring without data loss

### Twitter Scraping Without Auth
**Issue:** Twitter normally requires authentication to view profiles.

**Solution:** The monitor exploits a brief window during page load where Twitter shows follower/following counts before requiring login. This allows checking Twitter metrics without any authentication or cookies.

### Rate Limit Prevention
**Issue:** Both Twitter and Tribe.run eventually rate limit repeated requests.

**Solution:**
- Maintains pool of rotating proxies
- Automatically refreshes sessions when needed
- Uses exponential backoff for retries
- Keeps separate browser tabs for Tribe.run and Twitter
