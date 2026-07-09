FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_OPTIONS="--max-old-space-size=460"
ENV DATA_DIR=/app/data
ENV PORT=10000

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data/sessions /app/data/uploads /app/data/exports

EXPOSE 10000
CMD ["node", "server.js"]
