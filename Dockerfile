# ada-server — the routing backend (holds provider keys). SERVER-ONLY image: no node-pty (that's a
# client tool), no skills/docs/bench. Runs the same no-build tsx launcher as the `ada-server` binary.
#
#   docker build -t ada-server .
#   docker run -p 8787:8787 -v ada-data:/data --env-file .env ada-server
#
# See docs/deploy.md for env vars, persistence, and Cloudflare hosting notes.
FROM node:22-slim
WORKDIR /app

# Production deps only, and skip optional native ones (node-pty) — the server never opens a PTY, so
# the image needs no C toolchain. Layer is cached until package.json/lock change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# App sources (tsx runs the TypeScript directly — no build step).
COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/

ENV ADA_PORT=8787
ENV ADA_DATA_DIR=/data
# Persist seats / policy / usage / audit across restarts — mount a volume here (see docs/deploy.md).
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ADA_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ponytail: runs as root so a mounted /data volume is always writable; add `USER node` + a
# uid-1000-writable volume if your host requires non-root.
CMD ["node", "bin/ada-server.mjs"]
