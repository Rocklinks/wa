FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    chromium ca-certificates fonts-liberation \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgbm1 libgtk-3-0 \
    libasound2 libxss1 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-old-space-size=450"
ENV DATA_DIR=/app/data
ENV PORT=10000

WORKDIR /app
COPY package.json .
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev
COPY . .
RUN mkdir -p /app/data/sessions /app/data/uploads /app/data/exports

EXPOSE 10000
CMD ["node", "server.js"]
