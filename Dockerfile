FROM openwa/wa-automate:latest

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /data/sessions /data/uploads /data/exports

ENV DATA_DIR=/data
ENV PORT=8080
ENV NODE_OPTIONS="--max-old-space-size=450"

EXPOSE 8080
CMD ["node", "server.js"]
