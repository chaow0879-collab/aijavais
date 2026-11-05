# Zero third-party runtime dependencies; Node 24 supplies node:sqlite.
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/chaow0879-collab/aijavais"
WORKDIR /app
ENV NODE_ENV=production AIJ_ENV=production TRUST_PROXY=1 HOST=0.0.0.0 PORT=8787 AIJ_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data /app
COPY --chown=node:node package.json server.js LICENSE NOTICE.md ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node public ./public
COPY --chown=node:node tools ./tools
USER node
VOLUME ["/data"]
# EXPOSE documents the private reverse-proxy port; it does not publish a host port.
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD node -e 'fetch("http://127.0.0.1:8787/healthz").then(async r=>{const s=await r.json();if(!r.ok||s.ok!==true)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "server.js"]
