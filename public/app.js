// Global State
let currentScrapedData = null;
let activeEventSource = null;
let activeAbortController = null;
let downloadQueue = [];
let queueIsRunning = false;
let currentQueueIndex = 0;

// Format duration helper (seconds -> mm:ss or hh:mm:ss)
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    const mStr = m < 10 && h > 0 ? `0${m}` : `${m}`;
    const sStr = s < 10 ? `0${s}` : `${s}`;
    
    return h > 0 ? `${h}:${mStr}:${sStr}` : `${mStr}:${sStr}`;
}

// Format size helper (bytes -> MB)
function formatSize(bytes) {
    if (!bytes || isNaN(bytes)) return 'Variable';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initVideoDownloader();
    initWebScraper();
    initAIAssistant();
    initHistory();
    initSettings();
    initGlobalProgress();
    init3dTilt();
    checkHashParams();
});

// Watch for incoming bookmarklet parameters on hash changes
window.addEventListener('hashchange', checkHashParams);

/* ==========================================
   TAB NAVIGATION SYSTEM
   ========================================== */
function initTabs() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabPanes = document.querySelectorAll('.tab-pane');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetTab = item.getAttribute('data-tab');

            // Remove active classes
            navItems.forEach(nav => nav.classList.remove('active'));
            tabPanes.forEach(pane => pane.classList.remove('active'));

            // Add active class to selected tab
            item.classList.add('active');
            const targetPane = document.getElementById(targetTab);
            if (targetPane) {
                targetPane.classList.add('active');
            }

            // Sync hash in URL
            window.location.hash = targetTab;
        });
    });

    // Check location hash on load
    if (window.location.hash) {
        const hash = window.location.hash.substring(1);
        const matchItem = document.querySelector(`.nav-item[data-tab="${hash}"]`);
        if (matchItem) {
            matchItem.click();
        }
    }
}

/* ==========================================
   GLOBAL DOWNLOAD PROGRESS & SSE PIPELINE
   ========================================== */
function initGlobalProgress() {
    const modal = document.getElementById('progress-modal');
    const btnCancel = document.getElementById('btn-cancel-dl');
    
    btnCancel.addEventListener('click', () => {
        let wasCancelled = false;
        if (activeEventSource) {
            activeEventSource.close();
            activeEventSource = null;
            addLogLine('[System] Download cancelled by user.');
            wasCancelled = true;
        }
        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
            addLogLine('[System] Client-side download aborted by user.');
            wasCancelled = true;
        }
        
        if (wasCancelled) {
            if (downloadQueue.length > 0 && queueIsRunning) {
                // If in a bulk download queue, cancel queue
                downloadQueue = [];
                queueIsRunning = false;
                addLogLine('[System] Bulk queue cancelled.');
            }
            
            setTimeout(() => {
                modal.classList.add('hidden');
            }, 1000);
        }
    });
}

async function downloadFileClientSide(url, ext, filename) {
    const modal = document.getElementById('progress-modal');
    const barFill = document.getElementById('progress-bar-fill');
    const txtFilename = document.getElementById('progress-filename');
    const txtStatus = document.getElementById('progress-status-text');
    const statPercent = document.getElementById('stat-percent');
    const statSpeed = document.getElementById('stat-speed');
    const statEta = document.getElementById('stat-eta');
    const statSize = document.getElementById('stat-size');
    const consoleLogs = document.getElementById('console-logs');

    // Reset progress UI
    modal.classList.remove('hidden');
    barFill.style.width = '0%';
    txtFilename.textContent = filename || 'Resolving direct file...';
    txtStatus.textContent = 'Connecting client-side...';
    statPercent.textContent = '0.0%';
    statSpeed.textContent = '0.0 MB/s';
    statEta.textContent = '00:00';
    statSize.textContent = '0 MB / 0 MB';
    consoleLogs.textContent = '[Client-side] Initializing direct download stream...\n';

    if (activeAbortController) activeAbortController.abort();
    activeAbortController = new AbortController();

    try {
        const response = await fetch(url, { 
            mode: 'cors',
            signal: activeAbortController.signal
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const contentType = response.headers.get('content-type') || '';
        // If it's a playlist or html, fall back
        if (contentType.includes('html') || contentType.includes('mpegurl') || url.includes('.m3u8') || url.includes('.mpd')) {
            throw new Error('Not a direct media file');
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        
        if (total === 0) {
            throw new Error('Unknown size or empty content');
        }

        consoleLogs.textContent += `[Client-side] Direct stream access granted. Size: ${(total / (1024 * 1024)).toFixed(2)} MB\n`;
        
        const reader = response.body.getReader();
        let receivedLength = 0;
        const chunks = [];
        const startTime = Date.now();

        while(true) {
            const {done, value} = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            
            const percent = ((receivedLength / total) * 100).toFixed(1);
            barFill.style.width = `${percent}%`;
            statPercent.textContent = `${percent}%`;
            
            const elapsed = (Date.now() - startTime) / 1000;
            const speedBytes = receivedLength / (elapsed || 1);
            const speed = speedBytes > 1024 * 1024 
                ? `${(speedBytes / (1024 * 1024)).toFixed(2)} MB/s` 
                : `${(speedBytes / 1024).toFixed(2)} KB/s`;
            
            const etaSecs = speedBytes > 0 ? Math.round((total - receivedLength) / speedBytes) : -1;
            const eta = etaSecs >= 0 ? `${Math.floor(etaSecs / 60)}m ${etaSecs % 60}s` : 'Unknown';
            
            statSpeed.textContent = speed;
            statEta.textContent = eta;
            statSize.textContent = `${(receivedLength / (1024 * 1024)).toFixed(1)} MB / ${(total / (1024 * 1024)).toFixed(1)} MB`;
            txtStatus.textContent = `Downloading directly (${percent}%)`;
        }

        txtStatus.textContent = 'Saving file...';
        const blob = new Blob(chunks);
        const blobUrl = URL.createObjectURL(blob);
        
        const triggerLink = document.createElement('a');
        triggerLink.href = blobUrl;
        const cleanExt = ext || 'mp4';
        const finalName = filename ? (filename.endsWith(`.${cleanExt}`) ? filename : `${filename}.${cleanExt}`) : `video_${Date.now()}.${cleanExt}`;
        triggerLink.download = finalName;
        document.body.appendChild(triggerLink);
        triggerLink.click();
        document.body.removeChild(triggerLink);
        URL.revokeObjectURL(blobUrl);

        txtStatus.textContent = 'Download Complete!';
        barFill.style.width = '100%';
        statPercent.textContent = '100%';
        consoleLogs.textContent += '[Client-side] Download completed successfully.\n';

        activeAbortController = null;
        saveToHistory(filename || 'Downloaded File', url, 'video', url);

        // Check queue
        if (queueIsRunning && downloadQueue.length > 0) {
            processNextQueueItem();
        } else {
            setTimeout(() => {
                modal.classList.add('hidden');
            }, 2000);
        }

        return true;
    } catch (err) {
        if (err.name === 'AbortError') {
            consoleLogs.textContent += `[Client-side] Download cancelled.\n`;
            return true; // Don't trigger fallback if aborted by user
        }
        consoleLogs.textContent += `[Warning] Direct client download failed: ${err.message}. Falling back to server-side pipeline...\n`;
        activeAbortController = null;
        return false;
    }
}

function startDownload(url, type, formatId = '', ext = '', filename = '', customReferer = '') {
    // If it's a direct media URL (not m3u8/mpd), try client-side download first
    const isDirectMedia = url.startsWith('http') && 
                          !url.includes('.m3u8') && 
                          !url.includes('.mpd') && 
                          (url.includes('.mp4') || url.includes('.mp3') || url.includes('.m4a') || url.includes('.webm') || type === 'image');

    if (isDirectMedia) {
        downloadFileClientSide(url, ext, filename).then(success => {
            if (!success) {
                executeServerSideDownload(url, type, formatId, ext, filename, customReferer);
            }
        });
    } else {
        executeServerSideDownload(url, type, formatId, ext, filename, customReferer);
    }
}

function executeServerSideDownload(url, type, formatId = '', ext = '', filename = '', customReferer = '') {
    const modal = document.getElementById('progress-modal');
    const barFill = document.getElementById('progress-bar-fill');
    const txtFilename = document.getElementById('progress-filename');
    const txtStatus = document.getElementById('progress-status-text');
    
    const statPercent = document.getElementById('stat-percent');
    const statSpeed = document.getElementById('stat-speed');
    const statEta = document.getElementById('stat-eta');
    const statSize = document.getElementById('stat-size');
    const consoleLogs = document.getElementById('console-logs');

    // Reset progress UI
    modal.classList.remove('hidden');
    barFill.style.width = '0%';
    txtFilename.textContent = filename || 'Resolving file...';
    txtStatus.textContent = 'Contacting server...';
    statPercent.textContent = '0.0%';
    statSpeed.textContent = '0.0 MB/s';
    statEta.textContent = '00:00';
    statSize.textContent = '0 MB / 0 MB';
    consoleLogs.textContent = '[System] Initializing server-side download stream...\n';

    // Extract headers bypass if present
    const referer = customReferer || document.getElementById('dl-referer')?.value.trim() || '';
    const userAgent = document.getElementById('dl-ua')?.value.trim() || '';

    // Format target API url
    const queryParams = new URLSearchParams({
        url,
        type,
        formatId,
        ext,
        filename
    });

    if (referer) queryParams.append('referer', referer);
    if (userAgent) queryParams.append('userAgent', userAgent);
    
    // Create Event Source
    if (activeEventSource) activeEventSource.close();
    
    activeEventSource = new EventSource(`/api/download-stream?${queryParams.toString()}`);

    activeEventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        
        if (data.log) {
            addLogLine(data.log);
        }

        switch (data.status) {
            case 'fetching':
                txtStatus.textContent = data.message || 'Fetching file information...';
                break;
            case 'downloading':
                txtStatus.textContent = 'Downloading file...';
                barFill.style.width = `${data.percent}%`;
                statPercent.textContent = `${data.percent}%`;
                statSpeed.textContent = data.speed;
                statEta.textContent = data.eta;
                statSize.textContent = data.size;
                break;
            case 'merging':
                txtStatus.textContent = 'Merging video and audio (FFmpeg)...';
                barFill.style.width = '99%';
                statPercent.textContent = '99.0%';
                break;
            case 'converting':
                txtStatus.textContent = 'Extracting / converting audio tracks...';
                barFill.style.width = '99.5%';
                statPercent.textContent = '99.5%';
                break;
            case 'complete':
                txtStatus.textContent = 'Download Complete!';
                barFill.style.width = '100%';
                statPercent.textContent = '100%';
                addLogLine('[System] File downloaded successfully. Triggering browser download...');
                
                activeEventSource.close();
                activeEventSource = null;
                
                // Add to history
                saveToHistory(filename || 'Downloaded File', url, type, data.downloadUrl);

                // Trigger browser local download
                const triggerLink = document.createElement('a');
                triggerLink.href = data.downloadUrl;
                triggerLink.download = ''; // Let browser use suggested name
                document.body.appendChild(triggerLink);
                triggerLink.click();
                document.body.removeChild(triggerLink);

                // Check queue
                if (queueIsRunning && downloadQueue.length > 0) {
                    processNextQueueItem();
                } else {
                    setTimeout(() => {
                        modal.classList.add('hidden');
                    }, 2000);
                }
                break;
        }
    });

    activeEventSource.addEventListener('error', (e) => {
        let errDetails = 'Connection failed';
        if (e.data) {
            try {
                const data = JSON.parse(e.data);
                errDetails = data.error || data.details || errDetails;
            } catch (err) {}
        }
        
        txtStatus.textContent = 'Download Failed!';
        addLogLine(`[Error] ${errDetails}`);
        
        if (activeEventSource) {
            activeEventSource.close();
            activeEventSource = null;
        }

        if (queueIsRunning && downloadQueue.length > 0) {
            addLogLine('[System] Error in bulk queue. Moving to next item in 3s...');
            setTimeout(processNextQueueItem, 3000);
        }
    });
}

function addLogLine(text) {
    const consoleLogs = document.getElementById('console-logs');
    if (consoleLogs) {
        consoleLogs.textContent += `${text}\n`;
        // Auto-scroll
        consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }
}

/* ==========================================
   TAB 1: DIRECT VIDEO DOWNLOADER (YT-DLP)
   ========================================== */
function initVideoDownloader() {
    const inputUrl = document.getElementById('dl-url');
    const btnAnalyze = document.getElementById('dl-analyze-btn');
    const loading = document.getElementById('dl-loading');
    const errorContainer = document.getElementById('dl-error');
    const errorMsg = document.getElementById('dl-error-message');
    const resultCard = document.getElementById('dl-result');

    // Subtab elements
    const subtabs = document.querySelectorAll('.subtab-btn');
    const subpanes = document.querySelectorAll('.subtab-pane');

    subtabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-subtab');
            subtabs.forEach(t => t.classList.remove('active'));
            subpanes.forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(target).classList.add('active');
        });
    });

    // Help Tab switching
    const helpTabs = document.querySelectorAll('.help-tab-nav-btn');
    const helpPanes = document.querySelectorAll('.help-tab-pane');

    helpTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-helptab');
            helpTabs.forEach(t => t.classList.remove('active'));
            helpPanes.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(target).classList.add('active');
        });
    });

    btnAnalyze.addEventListener('click', () => {
        const url = inputUrl.value.trim();
        if (!url) return alert('Please enter a video URL');

        const referer = document.getElementById('dl-referer').value.trim();
        const userAgent = document.getElementById('dl-ua').value.trim();

        // Reset states
        loading.classList.remove('hidden');
        errorContainer.classList.add('hidden');
        resultCard.classList.add('hidden');

        const queryParams = new URLSearchParams({ url });
        if (referer) queryParams.append('referer', referer);
        if (userAgent) queryParams.append('userAgent', userAgent);

        fetch(`/api/info?${queryParams.toString()}`)
            .then(res => {
                if (!res.ok) {
                    return res.json().then(err => { throw new Error(err.error || 'Failed to fetch video details') });
                }
                return res.json();
            })
            .then(data => {
                loading.classList.add('hidden');
                renderVideoDetails(data);
            })
            .catch(err => {
                loading.classList.add('hidden');
                errorMsg.textContent = err.message;
                errorContainer.classList.remove('hidden');
            });
    });
}

function renderVideoDetails(data) {
    const resultCard = document.getElementById('dl-result');
    const thumb = document.getElementById('meta-thumb');
    const duration = document.getElementById('meta-duration');
    const title = document.getElementById('meta-title');
    const uploader = document.getElementById('meta-uploader');
    const platform = document.getElementById('meta-platform');

    // Set core info
    thumb.src = data.thumbnail || 'https://placehold.co/600x400';
    duration.textContent = formatDuration(data.duration);
    title.textContent = data.title;
    uploader.textContent = data.uploader;
    platform.textContent = data.extractor;

    // Render format containers
    const hqContainer = document.getElementById('hq-formats-container');
    const sdContainer = document.getElementById('sd-formats-container');
    const audioContainer = document.getElementById('audio-formats-container');

    hqContainer.innerHTML = '';
    sdContainer.innerHTML = '';
    audioContainer.innerHTML = '';

    const formats = data.formats || [];
    const isDirectStream = data.extractor === 'Headless Sniffer' || data.extractor === 'Generic';
    const referer = data.referer || '';

    // Group 1: Audio Only formats
    const audioFormats = formats.filter(f => f.type === 'audio');
    if (audioFormats.length > 0) {
        audioFormats.forEach(f => {
            const dlUrl = isDirectStream ? (f.url || data.webpage_url) : data.webpage_url;
            const card = createFormatCard(dlUrl, 'audio', f.format_id, f.ext, `${f.resolution} (${f.quality_note || f.ext})`, f.filesize, data.title, referer);
            audioContainer.appendChild(card);
        });
    } else {
        // Fallback standard options if none found
        const dlUrl = data.webpage_url;
        audioContainer.innerHTML = `
            <div class="format-card">
                <div class="format-meta">
                    <span class="format-res">Extract MP3 (High Quality)</span>
                    <span class="format-size">Auto-extracted</span>
                </div>
                <button class="btn btn-primary btn-sm dl-btn" data-url="${dlUrl}" data-type="audio" data-format="mp3" data-ext="mp3" data-title="${data.title}" data-referer="${referer}">Download</button>
            </div>
            <div class="format-card">
                <div class="format-meta">
                    <span class="format-res">Extract M4A (Fastest)</span>
                    <span class="format-size">Auto-extracted</span>
                </div>
                <button class="btn btn-primary btn-sm dl-btn" data-url="${dlUrl}" data-type="audio" data-format="m4a" data-ext="m4a" data-title="${data.title}" data-referer="${referer}">Download</button>
            </div>
        `;
    }

    // Group 2: High Quality Video (Merged)
    const videoOnlyFormats = formats.filter(f => f.type === 'video-only');
    if (videoOnlyFormats.length > 0) {
        videoOnlyFormats.sort((a,b) => {
            const resA = parseInt(a.resolution) || 0;
            const resB = parseInt(b.resolution) || 0;
            return resB - resA;
        });

        videoOnlyFormats.forEach(f => {
            const formatId = `${f.format_id}+bestaudio/best`;
            const dlUrl = isDirectStream ? (f.url || data.webpage_url) : data.webpage_url;
            const card = createFormatCard(dlUrl, 'video', formatId, 'mp4', `${f.resolution} (${f.quality_note || f.ext}) [HD]`, f.filesize, data.title, referer);
            hqContainer.appendChild(card);
        });
    } else {
        hqContainer.innerHTML = '<p class="info-alert">No separate high-quality feeds available for this URL.</p>';
    }

    // Group 3: Pre-merged Standard Quality Video
    const standardFormats = formats.filter(f => f.type === 'video');
    if (standardFormats.length > 0) {
        standardFormats.forEach(f => {
            const dlUrl = isDirectStream ? (f.url || data.webpage_url) : data.webpage_url;
            const card = createFormatCard(dlUrl, 'video', f.format_id, f.ext, `${f.resolution} (${f.quality_note || f.ext})`, f.filesize, data.title, referer);
            sdContainer.appendChild(card);
        });
    } else {
        // If no pre-merged streams, add generic "best" option
        const dlUrl = data.webpage_url;
        sdContainer.innerHTML = `
            <div class="format-card">
                <div class="format-meta">
                    <span class="format-res">Best Pre-merged Format</span>
                    <span class="format-size">Automatic size</span>
                </div>
                <button class="btn btn-primary btn-sm dl-btn" data-url="${dlUrl}" data-type="video" data-format="best" data-ext="mp4" data-title="${data.title}" data-referer="${referer}">Download</button>
            </div>
        `;
    }

    // Add click listeners to download buttons
    document.querySelectorAll('.dl-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const btnUrl = btn.getAttribute('data-url');
            const btnType = btn.getAttribute('data-type');
            const btnFormat = btn.getAttribute('data-format');
            const btnExt = btn.getAttribute('data-ext');
            const btnTitle = btn.getAttribute('data-title');
            const btnReferer = btn.getAttribute('data-referer') || '';
            
            startDownload(btnUrl, btnType, btnFormat, btnExt, btnTitle, btnReferer);
        });
    });

    resultCard.classList.remove('hidden');
}

function createFormatCard(url, type, formatId, ext, resName, sizeBytes, title, referer = '') {
    const card = document.createElement('div');
    card.className = 'format-card';
    
    card.innerHTML = `
        <div class="format-meta">
            <span class="format-res">${resName}</span>
            <span class="format-size">${formatSize(sizeBytes)}</span>
        </div>
        <button class="btn btn-primary btn-sm dl-btn" 
            data-url="${url}" 
            data-type="${type}" 
            data-format="${formatId}" 
            data-ext="${ext}" 
            data-title="${title}"
            data-referer="${referer}">
            Download
        </button>
    `;
    return card;
}

/* ==========================================
   TAB 2: GENERAL WEBSITE SCRAPER
   ========================================== */
function initWebScraper() {
    const inputUrl = document.getElementById('scrape-url');
    const btnScrape = document.getElementById('scrape-btn');
    const loading = document.getElementById('scrape-loading');
    const errorContainer = document.getElementById('scrape-error');
    const errorMsg = document.getElementById('scrape-error-message');
    const resultsCard = document.getElementById('scrape-results');
    
    const filterInput = document.getElementById('scraper-search-filter');
    const btnSelectAll = document.getElementById('scr-select-all');
    const btnDeselectAll = document.getElementById('scr-deselect-all');
    const btnBulkDl = document.getElementById('scr-bulk-dl');

    // Tab buttons inside scraper card
    const scrapTabs = document.querySelectorAll('.scraper-tab-btn');
    const scrapPanes = document.querySelectorAll('.scraper-tab-pane');

    scrapTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-scratab');
            scrapTabs.forEach(t => t.classList.remove('active'));
            scrapPanes.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(target).classList.add('active');
        });
    });

    btnScrape.addEventListener('click', () => {
        const url = inputUrl.value.trim();
        if (!url) return alert('Please enter a site URL');

        loading.classList.remove('hidden');
        errorContainer.classList.add('hidden');
        resultsCard.classList.add('hidden');

        fetch(`/api/scrape?url=${encodeURIComponent(url)}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to scrape webpage');
                return res.json();
            })
            .then(data => {
                loading.classList.add('hidden');
                currentScrapedData = data;
                renderScrapedAssets(data);
                
                // Enable AI card now that a site is scraped
                const aiContainer = document.getElementById('ai-interaction-container');
                aiContainer.classList.remove('card-disabled');
                const overlay = aiContainer.querySelector('.disabled-overlay');
                if (overlay) overlay.style.display = 'none';
            })
            .catch(err => {
                loading.classList.add('hidden');
                errorMsg.textContent = err.message;
                errorContainer.classList.remove('hidden');
            });
    });

    // Client-side text filtering
    filterInput.addEventListener('input', (e) => {
        const text = e.target.value.toLowerCase().trim();
        filterScrapedList(text);
    });

    // Checkbox managers
    btnSelectAll.addEventListener('click', () => {
        const activePane = document.querySelector('.scraper-tab-pane.active');
        const checkboxes = activePane.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            const parentRow = cb.closest('.asset-row') || cb.closest('.gallery-card');
            if (parentRow.style.display !== 'none') {
                cb.checked = true;
            }
        });
    });

    btnDeselectAll.addEventListener('click', () => {
        const activePane = document.querySelector('.scraper-tab-pane.active');
        const checkboxes = activePane.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
    });

    // Bulk download queue dispatcher
    btnBulkDl.addEventListener('click', () => {
        const activePane = document.querySelector('.scraper-tab-pane.active');
        const checkedBoxes = activePane.querySelectorAll('input[type="checkbox"]:checked');
        
        if (checkedBoxes.length === 0) {
            return alert('Please select at least one asset to download');
        }

        downloadQueue = [];
        checkedBoxes.forEach(cb => {
            downloadQueue.push({
                url: cb.getAttribute('data-url'),
                filename: cb.getAttribute('data-filename'),
                ext: cb.getAttribute('data-ext')
            });
        });

        queueIsRunning = true;
        currentQueueIndex = 0;
        
        addLogLine(`[Queue] Starting bulk download of ${downloadQueue.length} files...`);
        processNextQueueItem();
    });
}

function renderScrapedAssets(data) {
    const resultsCard = document.getElementById('scrape-results');
    const txtTitle = document.getElementById('scraped-site-title');
    const linkUrl = document.getElementById('scraped-site-url');

    txtTitle.textContent = data.title;
    linkUrl.href = data.url;
    linkUrl.textContent = data.url;

    // Set count indicators
    document.getElementById('count-images').textContent = data.images.length;
    document.getElementById('count-videos').textContent = data.videos.length;
    document.getElementById('count-audios').textContent = data.audios.length;
    document.getElementById('count-docs').textContent = data.docs.length;
    document.getElementById('count-links').textContent = data.links.length;

    // Galleries and lists containers
    const gallery = document.getElementById('gallery-container');
    const videos = document.getElementById('videos-container');
    const audios = document.getElementById('audios-container');
    const docs = document.getElementById('docs-container');
    const links = document.getElementById('links-container');

    gallery.innerHTML = '';
    videos.innerHTML = '';
    audios.innerHTML = '';
    docs.innerHTML = '';
    links.innerHTML = '';

    // Render Images (Grid)
    if (data.images.length > 0) {
        data.images.forEach((img, idx) => {
            const card = document.createElement('div');
            card.className = 'gallery-card';
            const extension = img.url.split('.').pop().split('?')[0] || 'jpg';
            const cleanName = img.name || `image_${idx+1}`;
            
            card.innerHTML = `
                <div class="card-overlay">
                    <input type="checkbox" data-url="${img.url}" data-filename="${cleanName}" data-ext="${extension}" data-index="${idx}">
                </div>
                <img src="${img.url}" alt="${cleanName}" onerror="this.src='https://placehold.co/200?text=Image+Load+Failed'">
                <div class="card-name-overlay">${cleanName}</div>
            `;
            
            // Image card clicking to toggle checkbox (ignoring direct click on overlay)
            card.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT') {
                    const cb = card.querySelector('input[type="checkbox"]');
                    cb.checked = !cb.checked;
                }
            });
            gallery.appendChild(card);
        });
    } else {
        gallery.innerHTML = '<p class="empty-state">No images found on page</p>';
    }

    // Render Videos list
    renderAssetRows(data.videos, videos, 'fa-video', 'scrape-file', 'mp4');
    
    // Render Audios list
    renderAssetRows(data.audios, audios, 'fa-music', 'scrape-file', 'mp3');

    // Render Documents list
    renderAssetRows(data.docs, docs, 'fa-file-invoice', 'scrape-file');

    // Render Raw Links list
    renderAssetRows(data.links, links, 'fa-link', 'scrape-file', 'html');

    resultsCard.classList.remove('hidden');
}

function renderAssetRows(assets, container, iconClass, type, defaultExt = '') {
    if (assets.length > 0) {
        assets.forEach((asset, idx) => {
            const row = document.createElement('div');
            row.className = 'asset-row';
            const extension = defaultExt || asset.url.split('.').pop().split('?')[0] || 'dat';
            
            row.innerHTML = `
                <input type="checkbox" data-url="${asset.url}" data-filename="${asset.name}" data-ext="${extension}" data-index="${idx}">
                <div class="asset-icon"><i class="fa-solid ${iconClass}"></i></div>
                <div class="asset-info">
                    <div class="asset-name" title="${asset.name}">${asset.name}</div>
                    <div class="asset-url" title="${asset.url}">${asset.url}</div>
                </div>
                <button class="btn btn-secondary btn-sm row-dl-btn" data-url="${asset.url}" data-filename="${asset.name}" data-ext="${extension}" data-type="${type}">
                    <i class="fa-solid fa-download"></i>
                </button>
            `;
            
            row.querySelector('.row-dl-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startDownload(asset.url, type, '', extension, asset.name);
            });

            row.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
                    const cb = row.querySelector('input[type="checkbox"]');
                    cb.checked = !cb.checked;
                }
            });

            container.appendChild(row);
        });
    } else {
        container.innerHTML = '<p class="empty-state">No assets found in this category</p>';
    }
}

// Bulk queue runner
function processNextQueueItem() {
    if (!queueIsRunning || downloadQueue.length === 0) {
        queueIsRunning = false;
        return;
    }

    if (currentQueueIndex >= downloadQueue.length) {
        // Done with all
        queueIsRunning = false;
        addLogLine('[System] Bulk queue downloads completed successfully!');
        setTimeout(() => {
            document.getElementById('progress-modal').classList.add('hidden');
        }, 2000);
        return;
    }

    const item = downloadQueue[currentQueueIndex];
    currentQueueIndex++;
    
    addLogLine(`[Queue] Downloading file ${currentQueueIndex} of ${downloadQueue.length}: ${item.filename}`);
    startDownload(item.url, 'scrape-file', '', item.ext, `[${currentQueueIndex}/${downloadQueue.length}] ${item.filename}`);
}

// Client filter
function filterScrapedList(text) {
    const activePane = document.querySelector('.scraper-tab-pane.active');
    const items = activePane.querySelectorAll('.asset-row, .gallery-card');

    items.forEach(item => {
        let name = '';
        if (item.classList.contains('asset-row')) {
            name = item.querySelector('.asset-name').textContent.toLowerCase();
        } else {
            name = item.querySelector('.card-name-overlay').textContent.toLowerCase();
        }

        if (name.includes(text)) {
            item.style.display = '';
        } else {
            item.style.display = 'none';
        }
    });
}

/* ==========================================
   TAB 3: AI ASSISTANT (OLLAMA INTEGRATION)
   ========================================== */
function initAIAssistant() {
    const btnCheck = document.getElementById('btn-check-ollama');
    const statusPill = document.getElementById('ollama-status');
    const modelInput = document.getElementById('ollama-model');
    const promptInput = document.getElementById('ai-user-prompt');
    const btnRunAi = document.getElementById('btn-run-ai');
    const aiStatusMsg = document.getElementById('ai-response-status');

    // Run connection diagnostic
    function checkOllamaConnection() {
        statusPill.textContent = 'Connecting...';
        statusPill.className = 'status-pill offline';

        // Ping backend test endpoint (we send empty array)
        fetch('/api/ai-filter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: 'ping',
                items: [],
                model: modelInput.value.trim()
            })
        })
        .then(res => res.json())
        .then(data => {
            // If it resolved without throw, Ollama is up! (It might return validation error or indices, either way the bridge is online)
            statusPill.textContent = 'Ollama Connected';
            statusPill.className = 'status-pill online';
        })
        .catch(err => {
            statusPill.textContent = 'Ollama Offline';
            statusPill.className = 'status-pill offline';
        });
    }

    btnCheck.addEventListener('click', checkOllamaConnection);
    // Initial silent check
    setTimeout(checkOllamaConnection, 1000);

    btnRunAi.addEventListener('click', () => {
        const query = promptInput.value.trim();
        const model = modelInput.value.trim();

        if (!query) return alert('Please enter a command for the AI selector');
        if (!currentScrapedData) return alert('Please scrape a webpage first');

        // Figure out which tab is active in the Scraper page to grab those elements
        const activeScrapeTab = document.querySelector('.scraper-tab-btn.active');
        const activeTabAttr = activeScrapeTab.getAttribute('data-scratab'); // scr-images, scr-videos, etc.
        
        let scrapeCategoryKey = 'links';
        if (activeTabAttr === 'scr-images') scrapeCategoryKey = 'images';
        else if (activeTabAttr === 'scr-videos') scrapeCategoryKey = 'videos';
        else if (activeTabAttr === 'scr-audios') scrapeCategoryKey = 'audios';
        else if (activeTabAttr === 'scr-docs') scrapeCategoryKey = 'docs';

        const activeAssets = currentScrapedData[scrapeCategoryKey];
        if (!activeAssets || activeAssets.length === 0) {
            return alert('No items found in this category to filter.');
        }

        aiStatusMsg.querySelector('span').textContent = `Ollama model "${model}" is filtering ${activeAssets.length} items...`;
        aiStatusMsg.classList.remove('hidden');

        fetch('/api/ai-filter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: query,
                items: activeAssets,
                model: model
            })
        })
        .then(res => {
            if (!res.ok) {
                return res.json().then(err => { throw new Error(err.details || err.error || 'AI filter execution failed') });
            }
            return res.json();
        })
        .then(data => {
            aiStatusMsg.classList.add('hidden');
            const indices = data.indices || [];
            
            // Check boxes based on indices
            const activePane = document.getElementById(activeTabAttr);
            const checkboxes = activePane.querySelectorAll('input[type="checkbox"]');
            
            // Uncheck all first
            checkboxes.forEach(cb => cb.checked = false);
            
            // Check matched
            indices.forEach(idx => {
                const targetCb = activePane.querySelector(`input[type="checkbox"][data-index="${idx}"]`);
                if (targetCb) targetCb.checked = true;
            });

            // Redirect back to scraper page to show results
            alert(`AI completed selection. Checked ${indices.length} matched items in the scraper tab!`);
            document.querySelector('.nav-item[data-tab="scraper"]').click();
        })
        .catch(err => {
            aiStatusMsg.classList.add('hidden');
            alert(`Ollama Error: ${err.message}`);
        });
    });
}

/* ==========================================
   TAB 4: DOWNLOAD HISTORY
   ========================================== */
function initHistory() {
    renderHistory();

    const btnClear = document.getElementById('btn-clear-history');
    btnClear.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear your local download logs?')) {
            localStorage.removeItem('fedagrab_history');
            renderHistory();
        }
    });
}

function saveToHistory(title, sourceUrl, type, downloadUrl) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('fedagrab_history')) || [];
    } catch (e) {}

    const newItem = {
        id: `hist_${Date.now()}`,
        title,
        sourceUrl,
        type,
        downloadUrl,
        timestamp: new Date().toLocaleString()
    };

    history.unshift(newItem); // Add to top
    localStorage.setItem('fedagrab_history', JSON.stringify(history.slice(0, 100))); // Cap at 100 entries
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('history-container');
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('fedagrab_history')) || [];
    } catch (e) {}

    if (history.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-folder-open"></i>
                <p>No downloads yet. Paste a link or scrape a page to get started!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    history.forEach(item => {
        const card = document.createElement('div');
        card.className = 'history-card';
        
        let icon = 'fa-file-arrow-down';
        if (item.type === 'video') icon = 'fa-video';
        else if (item.type === 'audio') icon = 'fa-music';
        else if (item.type === 'image') icon = 'fa-image';

        card.innerHTML = `
            <div class="history-icon"><i class="fa-solid ${icon}"></i></div>
            <div class="history-info">
                <div class="history-title" title="${item.title}">${item.title}</div>
                <div class="history-meta">
                    <span><i class="fa-solid fa-clock"></i> ${item.timestamp}</span>
                    <span><i class="fa-solid fa-link"></i> <a href="${item.sourceUrl}" target="_blank" class="highlight">Source Link</a></span>
                </div>
            </div>
            <a href="${item.downloadUrl}" download class="btn btn-secondary btn-sm"><i class="fa-solid fa-download"></i> Redownload</a>
        `;
        container.appendChild(card);
    });
}

/* ==========================================
   TAB 5: SETTINGS & OPERATIONS
   ========================================== */
function initSettings() {
    const btnUpdate = document.getElementById('btn-update-ytdlp');
    const updateLog = document.getElementById('update-status');
    const updateTxt = document.getElementById('update-log-text');

    btnUpdate.addEventListener('click', () => {
        updateLog.classList.remove('hidden');
        updateTxt.textContent = 'Executing: yt-dlp -U\nPlease wait, checking repository...';

        fetch('/api/update', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    updateTxt.textContent = `Error during update:\n${data.details}`;
                } else {
                    updateTxt.textContent = `Success!\n\nOutput Log:\n${data.output}`;
                }
            })
            .catch(err => {
                updateTxt.textContent = `Failed to contact server:\n${err.message}`;
            });
    });
}

/* ==========================================
   3D TILT & PREMIUM LOOKS
   ========================================== */
function init3dTilt() {
    const cards = document.querySelectorAll(
        '.metadata-card, .search-box-container, .sidebar, .scraper-results-card, .universal-help-card, .ai-config-card, .ai-interaction-card, .settings-card'
    );
    
    cards.forEach(el => {
        el.addEventListener('mousemove', (e) => {
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            const xc = rect.width / 2;
            const yc = rect.height / 2;
            
            const dx = x - xc;
            const dy = y - yc;
            
            const tiltX = -(dy / yc) * 3; // Max 3 degrees of 3D rotation
            const tiltY = (dx / xc) * 3;
            
            el.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(1.008, 1.008, 1.008)`;
            el.style.boxShadow = `0 16px 48px rgba(0, 242, 254, 0.12), 0 8px 32px 0 rgba(0, 0, 0, 0.4)`;
        });
        
        el.addEventListener('mouseleave', () => {
            el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
            el.style.boxShadow = '';
        });
    });
}

/* ==========================================
   BOOKMARKLET CATCHER & AUTO-LOAD
   ========================================== */
function checkHashParams() {
    const hash = window.location.hash;
    if (hash.includes('?')) {
        const parts = hash.split('?');
        const tab = parts[0].substring(1);
        const query = parts[1];
        const params = new URLSearchParams(query);
        const url = params.get('url');

        if (tab === 'downloader' && url) {
            const inputUrl = document.getElementById('dl-url');
            if (inputUrl) {
                inputUrl.value = url;
            }
            
            // Activate the downloader tab
            const navItem = document.querySelector(`.nav-item[data-tab="downloader"]`);
            if (navItem) {
                navItem.click();
            }
            
            // Automatically analyze after a short delay
            setTimeout(() => {
                const btnAnalyze = document.getElementById('dl-analyze-btn');
                if (btnAnalyze) {
                    btnAnalyze.click();
                }
            }, 600);
        }
    }
}
