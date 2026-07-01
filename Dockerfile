# Multi-purpose Dockerfile
# - Default CMD runs single.js (HF Spaces / Render / free hosts / smoke tests)
# - docker-compose.yml overrides CMD to run index.js (clustered + Redis) on VPS
FROM node:20-alpine
WORKDIR /app

# Install deps first for better caching.
COPY server/package.json server/package.json
WORKDIR /app/server
RUN npm install --omit=dev && npm cache clean --force

# Copy the rest.
WORKDIR /app
COPY server ./server
COPY public ./public

# HF Spaces default port; docker-compose overrides via env.
ENV PORT=7860
EXPOSE 7860 6778 6779 6780

# Health check for orchestrators.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-7860}/api/healthz || wget -qO- http://127.0.0.1:6779/healthz || exit 1

# Single-port mode by default.
CMD ["node", "server/single.js"]
