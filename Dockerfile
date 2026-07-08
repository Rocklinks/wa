FROM node:20-bookworm-slim

# All Chromium deps for Debian Bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libasound2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip Chrome download — use system Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-old-space-size=460"
ENV DATA_DIR=/app/data
ENV PORT=10000

WORKDIR /app

COPY package.json .
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

COPY . .

# Create data dirs (inside /app — no permission issues)
RUN mkdir -p /app/data/sessions /app/data/uploads /app/data/exports

EXPOSE 10000
CMD ["node", "server.js"]
