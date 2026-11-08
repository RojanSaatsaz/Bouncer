# Railway builds this image (railway.json sets builder = DOCKERFILE).
# Railpack's build-tool downloads from GitHub releases failed twice on 2026-11-08; this only needs Docker Hub + npm.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# node is PID 1, so SIGTERM from a redeploy reaches our shutdown handler (closes the Photon socket).
CMD ["node", "--import", "tsx", "src/index.ts"]
