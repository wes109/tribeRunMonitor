/// <reference types="bun-types" />
import type { Page, HTTPRequest, Browser } from 'puppeteer';
import puppeteer from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';

// Configuration
const WEBSITE_URL = "https://www.tribe.run/";
const TARGET_ENDPOINT = "/p/api/v1/explore";
const DISCORD_WEBHOOK_URL = "webhook";
const REQUEST_INTERVAL = 250; // Increased to 5 seconds between checks
const SESSION_REFRESH_INTERVAL = 60 * 60 * 1000; // Refresh every hour (increased from 30 minutes)
const PROXY_FILE = 'proxy.txt';
const BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--window-size=1920,1080'
];

// Watchlist for important names (case insensitive)
const WATCHLIST = [
    "ansem",
    // Add more keywords here
];

// Track processed tribes to prevent duplicates
const processedTribes = new Set<string>();
const processedTwitterUsernames = new Set<string>();

// Store the last captured API request
let lastCapturedRequest: { 
    url: string, 
    headers: Record<string, string>,
    method: string,
    cookies: string
} | null = null;

// Track ongoing Twitter scraping attempts
const ongoingScrapingAttempts = new Map<string, boolean>();

// Track last successful request time and processed tribes
let lastSuccessfulRequestTime = Date.now();
let requestCounter = 0;  // Add counter for requests

// Track active Python processes with cleanup timeouts
const activeProcesses = new Map<ChildProcess, NodeJS.Timeout>();

let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REQUESTS_BEFORE_REFRESH = 500; // Increased from 100 to 500 requests
const BACKOFF_DELAY = 1000;

// Track ongoing operations
let isProcessingTribe = false;

interface TwitterStats {
    followers: number;
    following: number;
    is_notable: boolean;
}

interface TribeInfo {
    displayName: string;
    twitterUsername: string;
    address: string;
    pfp: string;
    isWatchlisted: boolean;
    twitterStats?: TwitterStats | null;
}

// Add at the top with other constants
const PAGE_REFRESH_INTERVAL = 60000; // 30 seconds
const MAX_SESSION_REFRESH_ATTEMPTS = 3;
const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;
let consecutiveRefreshFailures = 0;

// Add at the top with other global variables
let twitterPage: Page | null = null;
let mainBrowser: Browser | null = null;
let mainCheckInterval: ReturnType<typeof setInterval> | null = null;

// Add this function for periodic page refresh
async function setupPageRefreshInterval(page: Page) {
    setInterval(async () => {
        if (!page.isClosed() && !isRefreshing) {
            try {
                isRefreshing = true;
                console.log('\n🔄 Refreshing tribe.run page...');
                // Clear all cookies
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');
                await client.send('Network.clearBrowserCache');
                
                // Refresh the page
                await page.goto(WEBSITE_URL, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                
                // Wait for new API endpoint response
                try {
                    await page.waitForResponse(
                        response => response.url().includes(TARGET_ENDPOINT),
                        { timeout: 10000 }
                    );
                    console.log('✅ Page refreshed successfully');
                    consecutiveFailures = 0;
                            } catch (e) {
                    console.log('API endpoint not detected after refresh, using existing request data');
                }
            } catch (error) {
                console.error('Error during page refresh:', error);
            } finally {
                isRefreshing = false;
            }
        }
    }, PAGE_REFRESH_INTERVAL);
}

function isWatchlisted(displayName: string): boolean {
    const lowerDisplayName = displayName.toLowerCase();
    return WATCHLIST.some(keyword => 
        lowerDisplayName.includes(keyword.toLowerCase())
    );
}

async function sendWebhook(tribe: TribeInfo) {
    try {
        const cleanTwitterUsername = tribe.twitterUsername.replace(/^@/, '');
        const twitterUrl = cleanTwitterUsername ? `https://x.com/${cleanTwitterUsername}` : '';
        
        let content = '';
        
        // Add @everyone if needed
        const shouldPingEveryone = tribe.isWatchlisted || 
            (tribe.twitterStats?.following ?? 0) > 0 && (tribe.twitterStats?.followers ?? 0) > 10000;
        
        if (shouldPingEveryone) {
            content = '@everyone\n\n';
        }
        
        // Add display name with Twitter link if available
        if (twitterUrl) {
            content += '\n━━━━━━━━━━━━━━━\n';
            content += `**[${tribe.displayName}](${twitterUrl})**`;
        } else {
            content += `**${tribe.displayName}**`;
        }
        
        // Add divider and Tribe link with extra spacing
        content += '\n━━━━━━━━━━━━━━━\n';
        content += `**[Tribe](https://tribe.run/user/${tribe.address})**`;
        content += '\n━━━━━━━━━━━━━━━';
        
        // Add Twitter stats if available
        if (tribe.twitterStats) {
            content += `\n**Followers:** ${tribe.twitterStats.followers.toLocaleString()}\n`;
            content += `\n**Following:** ${tribe.twitterStats.following.toLocaleString()}`;
            content += '\n━━━━━━━━━━━━━━━';
        }
        
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                username: '🎉 New Tribe Alert',
                content
            })
        });
    } catch (error) {
        console.error('Error sending webhook:', error);
    }
}

// Update getTwitterStatsFromTab function for better stat detection
async function getTwitterStatsFromTab(page: Page, username: string): Promise<TwitterStats | null> {
    try {
        console.log(`\n[DEBUG] Navigating to Twitter profile for @${username}...`);
        await page.goto(`https://x.com/${username}`, {
            waitUntil: 'domcontentloaded' // Changed from networkidle0 to be faster
        });

        // Wait for URL to stabilize (handle redirects)
        await page.waitForFunction(
            (username) => window.location.href.toLowerCase().includes(username.toLowerCase()),
            { timeout: 10000 },
            username
        );

        console.log('[DEBUG] Waiting for stats elements...');
        
        // Wait for any stats elements to appear
        const statsSelectors = [
            '[href$="/following"] span', 
            '[href$="/followers"] span',
            '[href*="/following"] span', 
            '[href*="/followers"] span',
            'a[href*="following"] span',
            'a[href*="followers"] span'
        ];

        const selector = statsSelectors.join(', ');
        await page.waitForFunction(
            (selector) => {
                const elements = document.querySelectorAll(selector);
                return Array.from(elements).some(el => el.textContent?.match(/\d/));
            },
            { timeout: 10000 },
            selector
        );

        const stats = await page.evaluate(() => {
            const findCount = (text: string) => {
                if (!text) return 0;
                console.log('[Browser] Processing text:', text);
                
                // Clean up the text
                text = text.replace(/,/g, '').toLowerCase();
                const numMatch = text.match(/([\d.]+)([km])?/i);
                if (!numMatch) return 0;
                
                const [_, num, modifier] = numMatch;
                const value = parseFloat(num);
                
                if (modifier === 'k') return Math.floor(value * 1000);
                if (modifier === 'm') return Math.floor(value * 1000000);
                return Math.floor(value);
            };

            // Try different selector patterns
            const patterns = [
                { following: '[href$="/following"] span', followers: '[href$="/followers"] span' },
                { following: '[href*="/following"] span', followers: '[href*="/followers"] span' },
                { following: 'a[href*="following"] span', followers: 'a[href*="followers"] span' }
            ];

            for (const pattern of patterns) {
                const followingEl = document.querySelector(pattern.following);
                const followersEl = document.querySelector(pattern.followers);
                
                if (followingEl && followersEl) {
                    const followingText = followingEl.textContent || '';
                    const followersText = followersEl.textContent || '';
                    
                    console.log('[Browser] Found texts:', { followingText, followersText });
                    
                    const following = findCount(followingText);
                    const followers = findCount(followersText);
                    
                    if (following > 0 || followers > 0) {
                        return { following, followers };
                    }
                }
            }

            return null;
        });

        if (stats) {
            console.log(`\nSuccess! Stats for @${username}:`);
            console.log(`👥 Followers: ${stats.followers.toLocaleString()}`);
            console.log(`👤 Following: ${stats.following.toLocaleString()}`);
            
            return {
                followers: stats.followers,
                following: stats.following,
                is_notable: stats.followers >= 50000
            };
        }

        console.log(`[DEBUG] Could not find stats for @${username}`);
        return null;

    } catch (error) {
        console.error(`[DEBUG] Error getting Twitter stats:`, error);
        return null;
    }
}

// Modify initializeBrowser to include the refresh interval
async function initializeBrowser() {
    console.log('🚀 Launching browser...');
    
    const proxy = await getNextProxy();
    console.log(`Using proxy: ${proxy.host}:${proxy.port}`);
    
    const { browser, page } = await createBrowserWithProxy(proxy);
    
    // Create and set up Twitter tab
    console.log('🐦 Creating Twitter tab...');
    twitterPage = await browser.newPage();
    
    // Set up proxy authentication for Twitter tab
    await twitterPage.authenticate({
        username: proxy.username,
        password: proxy.password
    });
    
    // Set up viewport and other settings
    await twitterPage.setViewport({ width: 1280, height: 720 });
    await twitterPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await twitterPage.setRequestInterception(true);
    
    // Block unnecessary resources for Twitter tab
    twitterPage.on('request', (request: HTTPRequest) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
        } else {
            request.continue();
        }
    });
    
    // Test Twitter scraping with @NOLA_SNKRS
    console.log('🧪 Testing Twitter scraping with @NOLA_SNKRS...');
    const testStats = await getTwitterStatsFromTab(twitterPage, 'EricTrump');
    if (testStats) {
        console.log('✅ Twitter scraping test successful!');
    } else {
        console.warn('⚠️ Twitter scraping test failed, but continuing...');
    }
    
    // Navigate to website in main tab
    console.log('🌐 Navigating to website...');
    await page.goto(WEBSITE_URL, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });
    
    try {
        await page.waitForResponse(
            response => response.url().includes(TARGET_ENDPOINT),
            { timeout: 10000 }
        );
    } catch (e) {
        console.log('Initial API endpoint not detected, but continuing...');
    }
    
    // Set up periodic page refresh
    setupPageRefreshInterval(page);
    
    console.log('📡 Monitoring for new tribes...');
    return { browser, page };
}

// Modify processNewTribe to use the persistent Twitter tab
async function processNewTribe(tribe: TribeInfo, browser: Browser) {
    isProcessingTribe = true;
    try {
    const twitterHandle = tribe.twitterUsername.toLowerCase();
    const address = tribe.address.toLowerCase();
    
    if (processedTribes.has(address) || (twitterHandle && processedTwitterUsernames.has(twitterHandle))) {
        console.log(`Skipping duplicate tribe: ${tribe.displayName} (${twitterHandle || address})`);
        return;
    }
    
    console.log(`Processing new tribe: ${tribe.displayName}`);
    
    processedTribes.add(address);
    if (twitterHandle) {
        processedTwitterUsernames.add(twitterHandle);
    }
    
        if (tribe.twitterUsername && twitterPage) {
            tribe.twitterStats = await getTwitterStatsFromTab(twitterPage, tribe.twitterUsername);
        }
        
    await sendWebhook(tribe);
    
    console.log(`Finished processing ${tribe.displayName}`);
    } finally {
        isProcessingTribe = false;
    }
}

// Add new proxy management functions
async function loadProxies(): Promise<Array<{host: string, port: number, username: string, password: string}>> {
    try {
        const proxyData = await fs.readFile(PROXY_FILE, 'utf-8');
        return proxyData.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [host, port, username, password] = line.trim().split(':');
                return {
                    host,
                    port: parseInt(port),
                    username,
                    password
                };
            });
    } catch (error) {
        console.error('Error loading proxies:', error);
        return [];
    }
}

let proxies: Array<{host: string, port: number, username: string, password: string}> = [];

async function getNextProxy() {
    if (proxies.length === 0) {
        proxies = await loadProxies();
        if (proxies.length === 0) {
            throw new Error('No proxies available');
        }
    }
    
    // Get a random proxy instead of sequential
    const randomIndex = Math.floor(Math.random() * proxies.length);
    const proxy = proxies[randomIndex];
    console.log(`Selected proxy ${randomIndex + 1}/${proxies.length}: ${proxy.host}:${proxy.port}`);
    return proxy;
}

async function setupPage(page: Page, proxy: { username: string, password: string }) {
    // Set up proxy authentication
    await page.authenticate({
        username: proxy.username,
        password: proxy.password
    });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block unnecessary resources
    await page.setRequestInterception(true);
    
    page.on('request', (request: HTTPRequest) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
        } else if (request.url().includes(TARGET_ENDPOINT)) {
            const cookies = page.cookies().then(cookies => {
                const cookieString = cookies
                    .map(cookie => `${cookie.name}=${cookie.value}`)
                    .join('; ');

                lastCapturedRequest = {
                    url: request.url(),
                    headers: request.headers(),
                    method: request.method(),
                    cookies: cookieString
                };
            });
            request.continue();
        } else {
            request.continue();
        }
    });
}

async function createBrowserWithProxy(proxy: { host: string, port: number, username: string, password: string }) {
    const browser = await puppeteer.launch({ 
        headless: false,  // Use headed mode for better stability
        args: [
            ...BROWSER_ARGS,
            `--proxy-server=${proxy.host}:${proxy.port}`
        ],
        defaultViewport: {
            width: 1280,
            height: 720
        }
    });
    
    const page = await browser.newPage();
    await setupPage(page, proxy);
    
    return { browser, page };
}

// Add at the top with other constants
const MAX_REFRESH_RETRIES = 3;
const REFRESH_BACKOFF_DELAY = 5000;
let isRefreshing = false;

// Update makeRequestWithLatestCapture to properly wait for refresh
async function makeRequestWithLatestCapture(page: Page, browser: Browser) {
    if (!lastCapturedRequest) {
        return { browser, page };
    }

    // If a refresh is in progress, wait for it to complete
    if (isRefreshing) {
        console.log('Refresh in progress, waiting...');
        while (isRefreshing) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('Refresh completed, resuming requests');
        consecutiveFailures = 0;
        return { browser, page };
    }

    try {
        // Check if page and browser are still valid
        if (!browser.isConnected() || page.isClosed()) {
            console.log('Browser or page no longer valid, refreshing session...');
            if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
                console.error(`\n❌ Too many consecutive refresh failures (${consecutiveRefreshFailures}). Exiting...`);
                process.exit(1);
            }
            const result = await refreshSession(page, browser);
            consecutiveFailures = 0;
            return result;
        }

        // Verify page is still valid before making request
        if (page.isClosed()) {
            throw new Error('Page is no longer valid');
        }

        const result = await page.evaluate(async (requestInfo: any) => {
            try {
            const response = await fetch(requestInfo.url, {
                method: requestInfo.method,
                headers: {
                    ...requestInfo.headers,
                    'Cookie': requestInfo.cookies
                },
                credentials: 'include'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            return await response.json();
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                return { error: errorMessage };
            }
        }, lastCapturedRequest).catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            return { error: errorMessage };
        });

        // Check if we got an error response
        if (result.error) {
            throw new Error(result.error);
        }

        // Process tribes and update counters
        let newTribesFound = false;
        for (const item of result.items) {
            if (item.tokenCreatedItem) {
                const twitterUsername = item.tokenCreatedItem.twitter?.username || '';
                const address = item.tokenCreatedItem.address || '';
                
                if (processedTribes.has(address) || (twitterUsername && processedTwitterUsernames.has(twitterUsername.toLowerCase()))) {
                    continue;
                }

                const tribe: TribeInfo = {
                    displayName: item.tokenCreatedItem.displayName || 'Unknown',
                    twitterUsername,
                    address,
                    pfp: item.tokenCreatedItem.pfp || '',
                    isWatchlisted: isWatchlisted(item.tokenCreatedItem.displayName || '')
                };
                
                newTribesFound = true;
                await processNewTribe(tribe, browser);
            }
        }
        
        if (!newTribesFound) {
            process.stdout.write('.');
        }
        
        lastSuccessfulRequestTime = Date.now();
        consecutiveFailures = 0;
        return { browser, page };

    } catch (error) {
        consecutiveFailures++;
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`\n❌ ${consecutiveFailures} consecutive request failures. Attempting to refresh page...`);
            
            if (!isRefreshing) {
                try {
                    isRefreshing = true;
                    console.log('Starting page refresh...');
                    // Try refreshing just the page first
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    console.log('Page refreshed successfully');
                    consecutiveFailures = 0;
                    isRefreshing = false;
                } catch (reloadError) {
                    console.error('Page refresh failed, will try session refresh');
                    if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
                        console.error(`\n❌ Too many consecutive refresh failures (${consecutiveRefreshFailures}). Exiting...`);
                        process.exit(1);
                    }
                    const result = await refreshSession(page, browser);
                    isRefreshing = false;
                    return result;
                }
            } else {
                console.log('Refresh already in progress, waiting...');
                while (isRefreshing) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                console.log('Refresh completed, resuming requests');
                consecutiveFailures = 0;
            }
        } else {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error making request:', errorMessage);
        }
    }
    
    return { browser, page };
}

// Update refreshSession to be more conservative
async function refreshSession(page: Page, browser: Browser, retryAttempt = 0) {
    if (isRefreshing) {
        console.log('Already refreshing, waiting...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { browser, page };
    }

    isRefreshing = true;
    try {
        console.log('\n🔄 Refreshing session with new proxy...');
        
        // Try to refresh the existing page first
        try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');
            
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log('Page refreshed successfully');
            
            // Wait for API endpoint
            try {
                await page.waitForResponse(
                    response => response.url().includes(TARGET_ENDPOINT),
                    { timeout: 10000 }
                );
                console.log('API endpoint detected after refresh');
                consecutiveRefreshFailures = 0;
                return { browser, page };
            } catch (e) {
                console.log('API endpoint not detected after refresh, will try proxy change');
            }
        } catch (reloadError) {
            console.log('Page refresh failed, will try proxy change');
        }

        // If page refresh fails, then try changing proxy
        const proxy = await getNextProxy();
        await setupPage(page, proxy);
        
        await page.goto(WEBSITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        try {
            await page.waitForResponse(
                response => response.url().includes(TARGET_ENDPOINT),
                { timeout: 10000 }
            );
            console.log('Session refreshed successfully with new proxy');
            consecutiveRefreshFailures = 0;
            return { browser, page };
        } catch (e) {
            throw new Error('Failed to detect API endpoint after proxy change');
        }
    } catch (error) {
        console.error(`Error refreshing session (attempt ${retryAttempt + 1}/${MAX_REFRESH_RETRIES}):`, error);
        consecutiveRefreshFailures++;
        
        if (retryAttempt < MAX_REFRESH_RETRIES - 1) {
            const delay = REFRESH_BACKOFF_DELAY * Math.pow(2, retryAttempt);
            console.log(`Retrying session refresh in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return refreshSession(page, browser, retryAttempt + 1);
        }
        
        throw new Error(`Failed to refresh session after ${MAX_REFRESH_RETRIES} attempts`);
    } finally {
        isRefreshing = false;
    }
}

async function startMonitoring() {
    try {
        let { browser, page } = await initializeBrowser();
        mainBrowser = browser;

        // Once we have captured a request, start monitoring
        mainCheckInterval = setInterval(async () => {
            if (lastCapturedRequest && !isRefreshing) {  // Only make requests if not refreshing
                const result = await makeRequestWithLatestCapture(page, browser);
                if (result) {
                    browser = result.browser;
                    mainBrowser = browser;
                    page = result.page;
                }
            }
        }, REQUEST_INTERVAL);

        // Cleanup on exit
        process.on('SIGINT', async () => {
            console.log('\n👋 Closing browser and cleaning up...');
            if (mainCheckInterval) {
                clearInterval(mainCheckInterval);
            }
            if (twitterPage && !twitterPage.isClosed()) {
                await twitterPage.close().catch(() => {});
            }
            if (mainBrowser) {
                await mainBrowser.close().catch(() => {});
            }
            process.exit();
        });

        // Additional cleanup on uncaught exceptions
        process.on('uncaughtException', async (error) => {
            console.error('❌ Uncaught exception:', error);
            if (mainCheckInterval) {
                clearInterval(mainCheckInterval);
            }
            if (twitterPage && !twitterPage.isClosed()) {
                await twitterPage.close().catch(() => {});
            }
            if (mainBrowser) {
                await mainBrowser.close().catch(() => {});
            }
            process.exit(1);
        });

        process.on('unhandledRejection', async (error) => {
            console.error('❌ Unhandled rejection:', error);
            if (mainCheckInterval) {
                clearInterval(mainCheckInterval);
            }
            if (twitterPage && !twitterPage.isClosed()) {
                await twitterPage.close().catch(() => {});
            }
            if (mainBrowser) {
                await mainBrowser.close().catch(() => {});
            }
            process.exit(1);
        });

    } catch (error) {
        console.error('❌ Error in monitoring:', error);
        await cleanupPythonProcesses();
        process.exit(1);
    }
}

// Start monitoring
console.log('Starting tribe monitor...');
startMonitoring().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

// Helper function to process count strings
function processCount(text: string): number {
    try {
        text = text.replace('Following', '').replace('Followers', '').trim();
        if (text.match(/^\d+$/)) {
            return parseInt(text);
        }
        text = text.toUpperCase();
        if (text.includes('K')) {
            return Math.floor(parseFloat(text.replace('K', '')) * 1000);
        }
        if (text.includes('M')) {
            return Math.floor(parseFloat(text.replace('M', '')) * 1000000);
        }
        return 0;
    } catch {
        return 0;
    }
}

// Remove Python process handling since we're using browser tabs
function cleanupPythonProcesses() {
    // This is no longer needed as we're using browser tabs
    return Promise.resolve();
}