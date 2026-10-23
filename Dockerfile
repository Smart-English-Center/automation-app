FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
COPY content ./content
COPY database/selc ./database/selc

ENV NODE_ENV=production TZ=UTC SCHEDULER_TIMEZONE=UTC APP_TIMEZONE=UTC PGOPTIONS="-c timezone=UTC"

EXPOSE 3000

CMD ["npm", "start"]
