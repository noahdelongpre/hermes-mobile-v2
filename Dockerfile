FROM node:22-alpine
# hermes-mobile-v2 — static + /api on Node, zero npm deps
WORKDIR /app
# tini for proper signal handling / PID 1
RUN apk add --no-cache tini
COPY server ./server
COPY public ./public
RUN mkdir -p /data/state /data/logs
ENV PORT=8123 \
    STATE_DIR=/data/state \
    LOG_DIR=/data/logs \
    AUTH_USER=noahd
EXPOSE 8123
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health | grep -q upstream || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.js"]
