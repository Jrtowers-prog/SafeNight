FROM node:20-slim

# Install osmium-tool for fast PBF processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    osmium-tool \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3006

VOLUME ["/app/data"]

EXPOSE 3006

CMD ["node", "src/main.js"]
