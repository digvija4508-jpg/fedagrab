const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Ensure directories exist
const PUBLIC_DIR = path.join(__dirname, 'public');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Serve static frontend files
app.use(express.static(PUBLIC_DIR));

// Active download tracking to allow cancellation
const activeDownloads = new Map();

/**
 * Clean up files in temp_downloads older than 1 hour (runs on server start and periodically)
 */
function cleanTempDirectory() {
    fs.readdir(TEMP_DIR, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                // Delete if older than 1 hour
                if (now - stats.mtimeMs > 60 * 60 * 1000) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}
setInterval(cleanTempDirectory, 30 * 60 * 1000); // every 30 minutes
cleanTempDirectory();

// Common executable paths on Windows for Chrome and Edge
const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function getBrowserPath() {
    // 1. Check environment variable (standard for Docker / Cloud VPS deployments)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Check Linux paths
    const LINUX_PATHS = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/chrome'
    ];
    if (process.platform !== 'win32') {
        for (const p of LINUX_PATHS) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
    }

    // 3. Check Windows paths
    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Sniffs video stream URLs by launching the local browser headlessly
 */
async function sniffStreamHeadless(url) {
    const executablePath = getBrowserPath();
    if (!executablePath) {
        throw new Error('Browser not found');
    }

    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        defaultViewport: { width: 1280, height: 800 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--mute-audio',
            '--disable-blink-features=AutomationControlled' // Bypass automation flags
        ]
    });

    try {
        const page = await browser.newPage();
        
        // Anti-bot stealth overrides (webdriver detection bypass)
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            window.chrome = { runtime: {} };
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        let foundStream = null;
        let foundReferer = '';
        let pageTitle = '';

        // Ignore common advertisement/telemetry domains to avoid false positives and speed up loading
        const isAd = (u) => {
            const lower = u.toLowerCase();
            return lower.includes('ads') || 
                   lower.includes('googleads') || 
                   lower.includes('doubleclick') || 
                   lower.includes('analytics') ||
                   lower.includes('pop') ||
                   lower.includes('telemetry') ||
                   lower.includes('adsystem') ||
                   lower.includes('adservice') ||
                   lower.includes('click') ||
                   lower.includes('banner');
        };

        // Helper to extract frame origin as Referer
        const getFrameReferer = (request) => {
            try {
                const frameUrl = request.frame() ? request.frame().url() : url;
                return new URL(frameUrl).origin + '/';
            } catch (e) {
                try {
                    return new URL(url).origin + '/';
                } catch (err) {
                    return '';
                }
            }
        };

        // 1. Network Request Interception (checking direct URLs)
        page.on('request', request => {
            const reqUrl = request.url();
            if (isAd(reqUrl)) return;

            if (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('.mpd')) {
                // Avoid capturing individual segment slices (.ts or .m4s) directly as the playlist URL
                if (!reqUrl.includes('.ts') && !reqUrl.includes('.m4s') && !reqUrl.includes('/segment')) {
                    foundReferer = getFrameReferer(request);
                    foundStream = reqUrl;
                }
            }
        });

        // 2. Network Response Sniffing (handles MIME types + JSON/Text API responses)
        page.on('response', async response => {
            if (foundStream) return;
            const req = response.request();
            const reqUrl = req.url();
            if (isAd(reqUrl)) return;

            const headers = response.headers();
            const contentType = headers['content-type'] || '';
            const status = response.status();

            if (status >= 200 && status < 300) {
                const resourceType = req.resourceType();
                
                // MIME content-type checks
                if (resourceType === 'media' || resourceType === 'xhr' || resourceType === 'fetch') {
                    if (contentType.includes('mpegurl') || 
                        contentType.includes('m3u8') || 
                        contentType.includes('video/') || 
                        contentType.includes('audio/') || 
                        contentType.includes('application/dash+xml')) {
                        
                        if (!reqUrl.includes('.ts') && !reqUrl.includes('.m4s') && !reqUrl.includes('/segment')) {
                            foundReferer = getFrameReferer(req);
                            foundStream = reqUrl;
                            return;
                        }
                    }
                }

                // Scan JSON or Text API responses for hidden stream links (e.g. vidplay/vidtube sources APIs)
                if (contentType.includes('json') || contentType.includes('javascript') || contentType.includes('plain')) {
                    try {
                        const text = await response.text();
                        // Clean escaping first to handle raw JSON strings containing \/
                        const cleanText = text.replace(/\\/g, '');
                        const streamRegex = /(https?:\/\/[^\s"'`<>]+?\.(?:m3u8|mpd|mp4)(?:[?#][^\s"'`<>]*?)?)/gi;
                        const match = cleanText.match(streamRegex);
                        if (match) {
                            for (const matchedUrl of match) {
                                if (!matchedUrl.includes('.ts') && !matchedUrl.includes('.m4s') && !matchedUrl.includes('/segment')) {
                                    foundReferer = getFrameReferer(req);
                                    foundStream = matchedUrl;
                                    console.log(`[Headless Sniffer] Intercepted stream link in API response: ${foundStream} with Referer: ${foundReferer}`);
                                    return;
                                }
                            }
                        }
                    } catch (err) {
                        // ignore body extraction errors (e.g. empty or binary content)
                    }
                }
            }
        });

        // Navigate to the target website
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        
        // Retrieve page title as default video title/filename
        try {
            pageTitle = await page.title();
            if (pageTitle) pageTitle = pageTitle.trim();
        } catch (e) {}

        // Helper to check DOM structures for direct video links
        const scanDOMForStreams = async () => {
            return await page.evaluate(() => {
                // Look for source tags within video tags
                const sources = Array.from(document.querySelectorAll('video source'));
                for (const s of sources) {
                    const src = s.getAttribute('src') || s.src;
                    const type = s.getAttribute('type') || '';
                    if (src && !src.startsWith('blob:')) {
                        if (type.includes('mpegurl') || type.includes('m3u8') || type.includes('mp4') || src.includes('.m3u8') || src.includes('.mp4')) {
                            return src;
                        }
                    }
                }
                
                // Look directly on video tags
                const videos = Array.from(document.querySelectorAll('video'));
                for (const v of videos) {
                    const src = v.getAttribute('src') || v.src;
                    if (src && !src.startsWith('blob:') && (src.includes('.m3u8') || src.includes('.mp4'))) {
                        return src;
                    }
                }
                
                // Look for iframe tags (e.g. video embed playlists)
                const iframes = Array.from(document.querySelectorAll('iframe'));
                for (const f of iframes) {
                    const src = f.getAttribute('src') || f.src;
                    if (src && (src.includes('.m3u8') || src.includes('.mp4'))) {
                        return src;
                    }
                }
                return null;
            });
        };

        // Scan DOM immediately after DOMContentLoaded
        let domStream = await scanDOMForStreams();
        if (domStream) {
            foundStream = domStream;
            try { foundReferer = new URL(url).origin + '/'; } catch(e) {}
        }

        // Wait 2 seconds for initial client-side player scripts to execute
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Re-scan DOM in case elements were loaded dynamically
        if (!foundStream) {
            domStream = await scanDOMForStreams();
            if (domStream) {
                foundStream = domStream;
                try { foundReferer = new URL(url).origin + '/'; } catch(e) {}
            }
        }

        // 3. Play Click Simulation: Trigger players requiring user interaction
        if (!foundStream) {
            // Click play button selectors
            await page.evaluate(() => {
                const playSelectors = [
                    '.play-button', '[aria-label="Play"]', '.jw-display-icon-container', 
                    '.vjs-big-play-button', '#player', '.player', '[class*="play"]', '[id*="play"]'
                ];
                playSelectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        try { el.click(); } catch (e) {}
                    });
                });
                
                // Force play on all video tags
                document.querySelectorAll('video').forEach(v => {
                    try { v.play(); } catch (e) {}
                });
            });

            // Click in the center of all iframes (ignoring tiny track/add frames)
            const iframes = await page.$$('iframe');
            for (const iframe of iframes) {
                try {
                    const box = await iframe.boundingBox();
                    if (box && box.width > 100 && box.height > 100) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    }
                } catch (err) {}
            }
        }

        // Wait up to 10 seconds for streams to trigger, polling every 500ms
        for (let i = 0; i < 20; i++) {
            if (foundStream) break;
            
            // Re-check DOM in case clicking/playing populated new source tags
            domStream = await scanDOMForStreams();
            if (domStream) {
                foundStream = domStream;
                try { foundReferer = new URL(url).origin + '/'; } catch(e) {}
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        return { streamUrl: foundStream, pageTitle, referer: foundReferer };
    } finally {
        await browser.close();
    }
}

/**
 * Formats standard yt-dlp outputs into a client-friendly JSON schema
 */
function formatYtdlpInfo(data) {
    const info = {
        id: data.id,
        title: data.title,
        thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || '',
        duration: data.duration, // in seconds
        uploader: data.uploader || data.channel || 'Unknown Creator',
        description: data.description || '',
        webpage_url: data.webpage_url,
        extractor: data.extractor_key || data.extractor || 'Generic',
        formats: []
    };

    if (data.formats && Array.isArray(data.formats)) {
        info.formats = data.formats.map(f => {
            let type = 'video';
            if (f.vcodec === 'none' && f.acodec !== 'none') type = 'audio';
            else if (f.vcodec !== 'none' && f.acodec === 'none') type = 'video-only';
            else if (f.vcodec === 'none' && f.acodec === 'none') type = 'video';

            return {
                format_id: f.format_id,
                ext: f.ext || 'mp4',
                resolution: f.resolution || (f.height ? `${f.height}p` : 'Unknown'),
                filesize: f.filesize || f.filesize_approx || null,
                fps: f.fps || null,
                container: f.container || f.ext || 'mp4',
                quality_note: f.format_note || f.quality || '',
                type,
                vcodec: f.vcodec,
                acodec: f.acodec,
                url: f.url || null
            };
        });
    }
    return info;
}

/**
 * Fallback metadata generator for dynamically-sniffed raw streams
 */
function returnDummyStreamInfo(res, originalUrl, streamUrl, referer, pageTitle) {
    const info = {
        id: `stream_${Date.now()}`,
        title: pageTitle || `Auto-Detected Media Stream`,
        thumbnail: '',
        duration: 0,
        uploader: 'Universal Stream Sniffer',
        description: 'This stream was captured automatically from the page player.',
        webpage_url: originalUrl,
        extractor: 'Headless Sniffer',
        referer: referer,
        formats: [
            {
                format_id: 'best',
                ext: 'mp4',
                resolution: 'Auto (Best Quality)',
                filesize: null,
                fps: null,
                container: 'mp4',
                quality_note: 'Direct Stream',
                type: 'video',
                vcodec: 'h264',
                acodec: 'aac',
                url: streamUrl // Direct HLS link
            }
        ]
    };
    res.json(info);
}

/**
 * Route: /api/info
 * Description: Fetches media metadata from yt-dlp, falling back to headless sniffer if unsupported
 */
app.get('/api/info', (req, res) => {
    const { url, referer, userAgent, cookiesFromBrowser } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const args = ['-J', '--flat-playlist'];
    if (referer) args.push('--referer', referer);
    if (userAgent) args.push('--user-agent', userAgent);
    if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
    args.push(url);

    // Spawn yt-dlp to get JSON representation of video
    const child = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
        stdout += data;
    });

    child.stderr.on('data', (data) => {
        stderr += data;
    });

    child.on('close', async (code) => {
        if (code !== 0) {
            console.error(`yt-dlp failed with code ${code}. Error: ${stderr}`);
            const isUnsupported = stderr.toLowerCase().includes('unsupported url') || 
                                  stderr.toLowerCase().includes('not supported') || 
                                  stderr.toLowerCase().includes('unable to download webpage');
            
            // Try headless browser stream sniffing fallback
            if (isUnsupported || code === 1) {
                console.log(`Bypassing block. Launching headless browser to sniff stream: ${url}`);
                try {
                    const snifferResult = await sniffStreamHeadless(url);
                    if (snifferResult && snifferResult.streamUrl) {
                        const { streamUrl, pageTitle } = snifferResult;
                        console.log(`Headless sniffer found video stream URL: ${streamUrl}`);
                        
                        // Use the sniffed Referer (the origin of the frame hosting the stream)
                        let refererDomain = snifferResult.referer || '';
                        if (!refererDomain) {
                            try {
                                refererDomain = new URL(url).origin + '/';
                            } catch (e) {}
                        }
                        
                        // Try to query yt-dlp on the direct stream URL
                        const streamArgs = ['-J', '--flat-playlist'];
                        if (refererDomain) streamArgs.push('--referer', refererDomain);
                        if (cookiesFromBrowser) streamArgs.push('--cookies-from-browser', cookiesFromBrowser);
                        streamArgs.push(streamUrl);

                        console.log(`Spawning yt-dlp to inspect direct stream: ${streamUrl}`);
                        const streamChild = spawn('yt-dlp', streamArgs);
                        let sStdout = '';
                        let sStderr = '';

                        streamChild.stdout.on('data', d => sStdout += d);
                        streamChild.stderr.on('data', d => sStderr += d);
                        
                        streamChild.on('error', (err) => {
                            console.error('Failed to start yt-dlp for stream:', err);
                            return returnDummyStreamInfo(res, url, streamUrl, refererDomain, pageTitle);
                        });

                        streamChild.on('close', (sCode) => {
                            console.log(`yt-dlp stream lookup closed with code ${sCode}`);
                            if (sCode !== 0) {
                                console.error(`yt-dlp stream lookup failed with stderr: ${sStderr}`);
                                return returnDummyStreamInfo(res, url, streamUrl, refererDomain, pageTitle);
                            }
                            try {
                                const data = JSON.parse(sStdout);
                                data.webpage_url = streamUrl; // Keep direct link for download trigger
                                // Prioritize webpage title over raw stream manifest title (which is usually a CDN token/hash)
                                const resolvedTitle = pageTitle || data.title || 'Video File';
                                data.title = `[Stream] ${resolvedTitle}`;
                                const info = formatYtdlpInfo(data);
                                info.referer = refererDomain;
                                console.log(`Returning metadata for resolves: ${data.title}`);
                                return res.json(info);
                            } catch(e) {
                                console.error('Failed to parse yt-dlp JSON:', e);
                                return returnDummyStreamInfo(res, url, streamUrl, refererDomain, pageTitle);
                            }
                        });
                        return; // Prevent standard error response
                    }
                } catch (err) {
                    console.error('Headless sniffer failed:', err.message);
                }
            }


            return res.status(500).json({ 
                error: isUnsupported ? 'Unsupported website' : 'Failed to retrieve media information',
                details: stderr.trim().split('\n').pop(),
                isUnsupported
            });
        }

        try {
            const data = JSON.parse(stdout);
            const info = formatYtdlpInfo(data);
            res.json(info);
        } catch (e) {
            console.error('Failed to parse JSON from yt-dlp:', e);
            res.status(500).json({ error: 'Failed to process media metadata', details: e.message });
        }
    });
});

/**
 * Helper to resolve relative URLs
 */
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch (e) {
        return relative;
    }
}

/**
 * Route: /api/scrape
 * Description: Scrapes arbitrary webpages for download links, videos, audio, and images
 */
app.get('/api/scrape', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': url
            },
            timeout: 10000
        });

        const html = response.data;
        const $ = cheerio.load(html);
        const pageTitle = $('title').text().trim() || 'Scraped Website';

        const result = {
            title: pageTitle,
            url: url,
            videos: [],
            audios: [],
            images: [],
            docs: [],
            links: []
        };

        // File extensions mapping for grouping
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m3u8', '.mpd'];
        const audioExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma'];
        const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz', '.txt', '.csv', '.epub', '.apk', '.exe'];
        const imgExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp'];

        // Helper to check extensions
        const hasExtension = (href, list) => {
            if (!href) return false;
            try {
                const pathname = new URL(href).pathname.toLowerCase();
                return list.some(ext => pathname.endsWith(ext));
            } catch (e) {
                // If it's a relative URL or direct query
                const cleanHref = href.split('?')[0].toLowerCase();
                return list.some(ext => cleanHref.endsWith(ext));
            }
        };

        // 1. Scan for Video Tags
        $('video').each((i, el) => {
            const src = $(el).attr('src');
            if (src) {
                const absSrc = resolveUrl(url, src);
                result.videos.push({ name: `Video HTML5 #${i+1}`, url: absSrc, type: 'video' });
            }
            $(el).find('source').each((j, sourceEl) => {
                const sourceSrc = $(sourceEl).attr('src');
                const sourceType = $(sourceEl).attr('type') || '';
                if (sourceSrc) {
                    const absSrc = resolveUrl(url, sourceSrc);
                    result.videos.push({ name: `Video Source #${i+1}-${j+1}`, url: absSrc, type: 'video', format: sourceType });
                }
            });
        });

        // 2. Scan for Audio Tags
        $('audio').each((i, el) => {
            const src = $(el).attr('src');
            if (src) {
                const absSrc = resolveUrl(url, src);
                result.audios.push({ name: `Audio HTML5 #${i+1}`, url: absSrc, type: 'audio' });
            }
            $(el).find('source').each((j, sourceEl) => {
                const sourceSrc = $(sourceEl).attr('src');
                if (sourceSrc) {
                    const absSrc = resolveUrl(url, sourceSrc);
                    result.audios.push({ name: `Audio Source #${i+1}-${j+1}`, url: absSrc, type: 'audio' });
                }
            });
        });

        // 3. Scan for Image Tags
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            const alt = $(el).attr('alt') || `Scraped Image #${i+1}`;
            if (src && !src.startsWith('data:')) {
                const absSrc = resolveUrl(url, src);
                result.images.push({ name: alt.trim(), url: absSrc });
            }
        });

        // 4. Scan all Anchor Links (a href)
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim() || `Link #${i+1}`;
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

            const absHref = resolveUrl(url, href);

            if (hasExtension(absHref, videoExtensions)) {
                result.videos.push({ name: text, url: absHref });
            } else if (hasExtension(absHref, audioExtensions)) {
                result.audios.push({ name: text, url: absHref });
            } else if (hasExtension(absHref, imgExtensions)) {
                // Deduplicate if already in images
                if (!result.images.some(img => img.url === absHref)) {
                    result.images.push({ name: text, url: absHref });
                }
            } else if (hasExtension(absHref, docExtensions)) {
                result.docs.push({ name: text, url: absHref });
            } else {
                result.links.push({ name: text, url: absHref });
            }
        });

        // De-duplicate array items by URL
        const uniqByUrl = arr => arr.filter((v, i, a) => a.findIndex(t => t.url === v.url) === i);
        result.videos = uniqByUrl(result.videos);
        result.audios = uniqByUrl(result.audios);
        result.images = uniqByUrl(result.images);
        result.docs = uniqByUrl(result.docs);
        result.links = uniqByUrl(result.links).slice(0, 100); // Cap raw links to 100 to avoid clutter

        res.json(result);
    } catch (e) {
        console.error('Failed to scrape site:', e);
        res.status(500).json({ error: 'Failed to scrape webpage', details: e.message });
    }
});

/**
 * Route: /api/download-stream
 * Description: Server-Sent Events (SSE) endpoint to run download and stream progress updates
 */
app.get('/api/download-stream', (req, res) => {
    const { url, type, formatId, ext, filename, referer, userAgent, cookiesFromBrowser } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Set SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const downloadId = `dl_${Date.now()}`;
    const cleanExt = ext || 'mp4';
    const targetFilename = `${downloadId}.${cleanExt}`;
    const tempFilePath = path.join(TEMP_DIR, targetFilename);

    const sendEvent = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    activeDownloads.set(downloadId, { res, activeProcess: null });

    // Handle connection closure
    req.on('close', () => {
        console.log(`Connection closed for download ${downloadId}`);
        const active = activeDownloads.get(downloadId);
        if (active && active.activeProcess) {
            try {
                active.activeProcess.kill();
            } catch (err) {
                // Ignore process kill errors
            }
        }
        activeDownloads.delete(downloadId);
    });

    // Case 1: Proxy Download from Scraper Asset (using Axios stream)
    if (type === 'scrape-file' || type === 'image') {
        sendEvent('progress', { status: 'fetching', message: 'Connecting to server...' });

        axios({
            url: url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': referer || url
            }
        })
        .then(response => {
            const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
            const writer = fs.createWriteStream(tempFilePath);
            let downloadedBytes = 0;
            let lastUpdate = Date.now();
            let lastDownloadedBytes = 0;

            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const now = Date.now();
                // Send progress updates at most every 400ms to avoid overwhelming client
                if (now - lastUpdate > 400 || downloadedBytes === totalBytes) {
                    const duration = (now - lastUpdate) / 1000;
                    const speedBytes = (downloadedBytes - lastDownloadedBytes) / duration;
                    const speed = speedBytes > 1024 * 1024 
                        ? `${(speedBytes / (1024 * 1024)).toFixed(2)} MB/s` 
                        : `${(speedBytes / 1024).toFixed(2)} KB/s`;
                    
                    const percent = totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : 0;
                    const sizeText = totalBytes 
                        ? `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
                        : `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;

                    const etaSecs = totalBytes ? Math.round((totalBytes - downloadedBytes) / speedBytes) : -1;
                    const eta = etaSecs >= 0 ? `${Math.floor(etaSecs / 60)}m ${etaSecs % 60}s` : 'Unknown';

                    sendEvent('progress', {
                        status: 'downloading',
                        percent: parseFloat(percent),
                        speed,
                        size: sizeText,
                        eta,
                        log: `Downloaded ${downloadedBytes} / ${totalBytes || 'Unknown'} bytes`
                    });

                    lastUpdate = now;
                    lastDownloadedBytes = downloadedBytes;
                }
            });

            response.data.pipe(writer);

            writer.on('finish', () => {
                const originalName = filename || `file_${Date.now()}.${cleanExt}`;
                sendEvent('progress', {
                    status: 'complete',
                    downloadUrl: `/api/files/${targetFilename}?name=${encodeURIComponent(originalName)}`
                });
                activeDownloads.delete(downloadId);
            });

            writer.on('error', (err) => {
                console.error('File write error:', err);
                sendEvent('error', { error: 'Failed to write file to disk', details: err.message });
                activeDownloads.delete(downloadId);
            });
        })
        .catch(err => {
            console.error('Axios stream download error:', err);
            sendEvent('error', { error: 'Failed to retrieve asset stream', details: err.message });
            activeDownloads.delete(downloadId);
        });

    } else {
        // Case 2: Media Download via yt-dlp
        sendEvent('progress', { status: 'fetching', message: 'Analyzing download links with yt-dlp...' });

        // Build yt-dlp arguments
        const args = [
            '--newline',
            '--progress',
            '--no-playlist',
            '-f', formatId || 'bestvideo+bestaudio/best',
            '-o', path.join(TEMP_DIR, `${downloadId}.%(ext)s`)
        ];

        if (referer) args.push('--referer', referer);
        if (userAgent) args.push('--user-agent', userAgent);
        if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);

        args.push(url);

        // If audio-only conversion is requested
        if (type === 'audio') {
            args.push('-x', '--audio-format', formatId || 'mp3', '--audio-quality', '0');
        }

        const child = spawn('yt-dlp', args);
        
        const active = activeDownloads.get(downloadId);
        if (active) active.activeProcess = child;

        // Keep track of logs
        child.stdout.on('data', (data) => {
            const line = data.toString().trim();
            if (!line) return;

            // Regex parsing: [download]  12.5% of  15.20MiB at  3.12MiB/s ETA 00:04
            const progressRegex = /\[download\]\s+(\d+\.\d+)%\s+of\s+(?:~)?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/;
            const progressMatch = line.match(progressRegex);

            if (progressMatch) {
                const [, percent, size, speed, eta] = progressMatch;
                sendEvent('progress', {
                    status: 'downloading',
                    percent: parseFloat(percent),
                    size,
                    speed,
                    eta,
                    log: line
                });
            } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
                sendEvent('progress', {
                    status: 'merging',
                    percent: 99.0,
                    size: 'Done downloading',
                    speed: 'N/A',
                    eta: 'Few seconds...',
                    log: 'Merging high-quality video and audio tracks...'
                });
            } else if (line.includes('[ffmpeg]') || line.includes('Extracting audio')) {
                sendEvent('progress', {
                    status: 'converting',
                    percent: 99.5,
                    size: 'Encoding',
                    speed: 'N/A',
                    eta: 'Almost done...',
                    log: 'Processing video/audio streams with FFmpeg...'
                });
            } else {
                // Generic informational log
                sendEvent('progress', {
                    status: 'processing',
                    log: line
                });
            }
        });

        child.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line) {
                sendEvent('progress', {
                    status: 'processing',
                    log: `stderr: ${line}`
                });
            }
        });

        child.on('close', (code) => {
            activeDownloads.delete(downloadId);
            if (code !== 0) {
                return sendEvent('error', { error: 'yt-dlp execution failed', details: `Exit code: ${code}` });
            }

            // Find the actual file in the temp directory (since yt-dlp might merge to different output extensions)
            fs.readdir(TEMP_DIR, (err, files) => {
                if (err) {
                    return sendEvent('error', { error: 'Failed to resolve downloaded file', details: err.message });
                }

                const downloadedFile = files.find(file => file.startsWith(downloadId));
                if (!downloadedFile) {
                    return sendEvent('error', { error: 'Downloaded file not found on server' });
                }

                const actualFilePath = path.join(TEMP_DIR, downloadedFile);
                const actualExt = path.extname(downloadedFile);
                
                // Let's name it using a cleaned title if available or standard name
                const originalName = filename ? `${filename}${actualExt}` : `download_${Date.now()}${actualExt}`;

                sendEvent('progress', {
                    status: 'complete',
                    downloadUrl: `/api/files/${downloadedFile}?name=${encodeURIComponent(originalName)}`
                });
            });
        });
    }
});

/**
 * Route: /api/files/:filename
 * Description: Downloads a completed file to the user's browser, then deletes it from server disk
 */
app.get('/api/files/:filename', (req, res) => {
    const filename = req.params.filename;
    const customName = req.query.name || filename;
    
    // Safety check - make sure filename doesn't contain directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const filePath = path.join(TEMP_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, customName, (err) => {
        if (err) {
            console.error('Error during file transfer:', err);
        }
        // Delete the file from the local server directory immediately after sending
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error('Failed to clean up file:', filePath, unlinkErr);
            else console.log('Successfully cleaned up temp file:', filename);
        });
    });
});

/**
 * Route: /api/ai-filter
 * Description: Proxies link filtering request to local Ollama instance (localhost:11434)
 */
app.post('/api/ai-filter', async (req, res) => {
    const { prompt, items, model = 'gemma' } = req.body;

    if (!prompt || !items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Prompt and an array of items are required' });
    }

    try {
        const ollamaUrl = 'http://localhost:11434/api/generate';
        
        const systemPrompt = `You are a web scraper AI assistant. The user wants to filter a list of scraped webpage assets based on a description: "${prompt}".
Here is the JSON list of assets containing 'name' and 'url':
${JSON.stringify(items.map((item, idx) => ({ index: idx, name: item.name, url: item.url })), null, 2)}

Filter these items and return ONLY a JSON array containing the indices of the matching assets.
Do not write any introduction, markdown formatting, or explanations. Respond with just a raw JSON array of indices, like this: [0, 4, 12].`;

        const response = await axios.post(ollamaUrl, {
            model: model,
            prompt: systemPrompt,
            stream: false,
            options: {
                temperature: 0.1
            }
        }, { timeout: 15000 });

        const aiResponseText = response.data.response.trim();
        
        // Extract array from response (in case AI wraps it in markdown backticks or text)
        const arrayRegex = /\[[\d\s,]*\]/;
        const match = aiResponseText.match(arrayRegex);
        
        if (match) {
            const indices = JSON.parse(match[0]);
            res.json({ indices });
        } else {
            // Attempt direct parse
            try {
                const indices = JSON.parse(aiResponseText);
                res.json({ indices });
            } catch (e) {
                res.status(500).json({ error: 'AI returned invalid format', details: aiResponseText });
            }
        }
    } catch (e) {
        console.error('Ollama connection failed:', e.message);
        res.status(500).json({ 
            error: 'Failed to connect to local Ollama instance', 
            details: 'Ensure Ollama is running on http://localhost:11434 and that the requested model is installed. ' + e.message 
        });
    }
});

/**
 * Route: /api/update
 * Description: Runs yt-dlp -U to update the global yt-dlp installation
 */
app.post('/api/update', (req, res) => {
    exec('yt-dlp -U', (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to update yt-dlp', details: stderr || err.message });
        }
        res.json({ message: 'Update completed successfully', output: stdout });
    });
});

app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(` FedaGrab Downloader running!`);
    console.log(` Access UI: http://localhost:${PORT}`);
    console.log(`========================================`);
});
