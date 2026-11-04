FROM node:22-alpine
RUN apk add --no-cache git diffutils
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN if [ -f bin/logs-watcher.js ]; then chmod 755 bin/logs-watcher.js && ln -s /app/bin/logs-watcher.js /usr/local/bin/logs-watcher; fi
ENV NODE_ENV=production HOME=/tmp LOGS_WATCHER_CONFIG=/etc/logs-watcher/config.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
