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
#
# Two exceptions for the Kokoro voice (/v1/tutor/speech):
#  - onnxruntime-node's install script fetches CUDA libraries on linux-x64 unless told not to; Cloud
#    Run has no GPU, so that is ~hundreds of MB of dead weight.
#  - sharp's native binary ships as an OPTIONAL platform package, which --omit=optional drops — and
#    kokoro-js's transformers imports sharp at load, so without it every voice request would fail.
#    Add just the linux-x64 pair, at the versions the lockfile already pins.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional \
  && npm install --no-save --omit=dev --omit=optional --no-audit --no-fund \
       $(node -p "const l = require('./package-lock.json').packages; ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'].map((n) => n + '@' + l['node_modules/' + n].version).join(' ')") \
  && npm cache clean --force

# Bake the Kokoro q8 model (~90 MB) into the image so a cold start never downloads it. Only the
# worker and its helper are copied first, so ordinary source edits reuse this layer. The bake
# synthesises one word — a broken voice fails the build here, not on a student's phone.
# Not under /data: that is a VOLUME, and anything a build writes there is discarded.
ENV ADA_KOKORO_DIR=/opt/kokoro
COPY src/server/kokoro-worker.mjs src/server/wav.mjs ./src/server/
RUN ADA_KOKORO_DOWNLOAD=1 node --input-type=module -e "const w = await import('./src/server/kokoro-worker.mjs'); const wav = await w.synth('af_heart', 'Ready.'); if (wav.length < 2000) throw new Error('kokoro bake produced no audio'); console.log('kokoro baked:', wav.length, 'bytes'); process.exit(0);"

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
