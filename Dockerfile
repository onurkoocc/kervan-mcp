# syntax=docker/dockerfile:1
# Dependencies are fetched in layers that see only the lock file and run no package
# scripts; the sources are compiled without network (SPEC §11, K43).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN --network=none npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3001 \
    LOG_FILE=/var/log/kervan/mcp.jsonl
WORKDIR /app
RUN mkdir -p /var/log/kervan && chown node:node /var/log/kervan
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
