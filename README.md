---
title: FedaGrab
emoji: 📥
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 3000
pinned: false
---

# FedaGrab - Universal Media Downloader & Scraper

FedaGrab is a premium web-based media downloader and website scraper designed to fetch media files, video streams, audio, and documents from almost any website. It features a modern tilted liquid glassmorphism interface and a powerful headless stream sniffer that automatically bypasses Cloudflare and other bot protections.

## Features

- **Direct Downloader**: Uses `yt-dlp` under the hood to download videos/audios from supported websites with live progress tracking.
- **Universal Headless Stream Sniffer**: When a site is unsupported or protected, it launches a headless browser, bypasses bot detection, simulates play clicks, intercepts stream playlists (`.m3u8`, `.mp4`, `.mpd`), resolves correct Referers, and extracts titles.
- **Webpage Scraper**: Recursively scans webpages for images, audios, videos, documents (PDF, ZIP, APK, EXE, etc.), and links.
- **Ollama AI Integration**: Filter scraped links semantically using natural language via a local Ollama AI model.
- **Auto-Cleanup**: Automatically cleans up downloaded files from server storage after serving them to the client to maintain 0% persistent disk usage.

---

## Free Cloud Deployment

Since FedaGrab requires headless Chromium, `ffmpeg`, and `yt-dlp` binaries, standard serverless hosts like Vercel will not work. FedaGrab is fully dockerized to run on container-based free hosting platforms.

### Option 1: Hugging Face Spaces (Recommended - 100% Free & 24/7)

Hugging Face Spaces provides a free 16GB RAM container running 24/7.
1. Sign up for a free account at [Hugging Face](https://huggingface.co/).
2. Click **New Space** (under your profile menu).
3. Name your Space, set the SDK to **Docker**, and select the **Blank** template.
4. Keep the Space **Public**.
5. Once created, go to the Space settings or repository, and push/upload this project (including the `Dockerfile`, `server.js`, and `public` folder) directly.
6. Hugging Face will automatically read the metadata at the top of this `README.md`, build your Docker container, and run it on a secure public URL!

### Option 2: Koyeb (Free Tier - 24/7)

Koyeb offers 24/7 Docker hosting on their free tier:
1. Create a free account on [Koyeb](https://www.koyeb.com/).
2. Connect your private GitHub repository containing this code.
3. Koyeb will automatically detect the `Dockerfile` and build it. Set the builder type to **Docker** and deploy.

### Option 3: Render (Free Tier - Sleeps on Inactivity)

Render runs Docker containers for free, but sleep after 15 minutes of inactivity:
1. Create a free account on [Render](https://render.com/).
2. Create a **New Web Service** and connect your GitHub repository.
3. Select **Docker** as the environment and deploy.

---

## Running Locally

1. **Install Prerequisites**:
   - Install [Node.js](https://nodejs.org/) (v18+).
   - Install [FFmpeg](https://ffmpeg.org/) and add it to your system PATH.
   - Install [yt-dlp](https://github.com/yt-dlp/yt-dlp) and add it to your system PATH.
   - Ensure Google Chrome or Microsoft Edge is installed in the default location.

2. **Setup and Start**:
   ```bash
   npm install
   npm start
   ```
   Open your browser and go to `http://localhost:3000`.
