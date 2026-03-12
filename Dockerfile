FROM oven/bun:1.3 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ src/
COPY tsconfig.json ./
RUN bun build src/index.ts --outdir dist --target node

FROM node:22-slim

RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser appuser

WORKDIR /app

COPY --from=builder --chown=appuser:appuser /app/dist/index.js ./dist/index.js
COPY --from=builder --chown=appuser:appuser /app/package.json ./

USER appuser

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
