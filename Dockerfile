# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY web ./web
COPY resources ./resources
COPY docs ./docs
RUN npm run typecheck && npm test && npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=37242 \
    JIRA_DB_PATH=/app/data/jira-mcp.sqlite

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --from=build --chown=node:node /app/resources ./resources
COPY --from=build --chown=node:node /app/docs ./docs

RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 37242
VOLUME ["/app/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||37242)+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
