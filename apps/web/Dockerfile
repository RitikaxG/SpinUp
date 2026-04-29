FROM node:20-bookworm-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV npm_config_cache=/tmp/.npm-cache

RUN apt-get update \
  && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm install --cache=/tmp/.npm-cache \
  && npm cache clean --force \
  && rm -rf /root/.npm /tmp/.npm-cache

RUN cd packages/db && npx prisma generate --schema=prisma/schema.prisma

EXPOSE 3000

CMD ["sh", "-c", "cd /app/apps/web && npm run dev -- --hostname 0.0.0.0 --port 3000"]