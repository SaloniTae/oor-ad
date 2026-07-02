FROM node:20-alpine
RUN apk add --no-cache python3 make g++ && rm -rf /var/cache/apk/*
WORKDIR /app

COPY server/package.json server/package.json
WORKDIR /app/server
RUN npm install --omit=dev --build-from-source && npm cache clean --force

WORKDIR /app
COPY server ./server
COPY public ./public

ENV PORT=7860
ENV DATA_DIR=/app/data
ENV DB_FILE=/app/data/app.db
ENV UPLOAD_DIR=/app/data/uploads
VOLUME ["/app/data"]

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-7860}/health || exit 1

CMD ["node", "server/src/index.js"]
