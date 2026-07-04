FROM openwa/wa-automate:latest

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data/sessions /app/data/uploads /app/data/exports

ENV DATA_DIR=/app/data
ENV PORT=10000
ENV NODE_OPTIONS="--max-old-space-size=450"

EXPOSE 10000
ENTRYPOINT []
CMD ["node", "server.js"]
