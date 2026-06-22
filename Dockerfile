# Use a lightweight Debian-based Node.js image
FROM node:20-slim

# Install system dependencies (ffmpeg, python3, curl, and Chromium dependencies)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp globally
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Configure Puppeteer to use the system-installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=3000

# Create and set the working directory
WORKDIR /usr/src/app

# Copy dependency definitions and install
COPY package*.json ./
RUN npm install

# Copy all project source files
COPY . .

# Expose port 3000 for web traffic
EXPOSE 3000

# Run the app
CMD [ "npm", "start" ]
