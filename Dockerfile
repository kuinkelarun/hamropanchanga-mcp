# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY mcp-server/package*.json ./mcp-server/
COPY mcp-client/package*.json ./mcp-client/

RUN cd mcp-server && npm ci
RUN cd mcp-client && npm ci --include=optional

COPY mcp-server ./mcp-server
COPY mcp-client ./mcp-client

RUN cd mcp-server && npm run build
RUN cd mcp-client && npm run build

# ---- runtime stage ----
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/mcp-server/package*.json ./mcp-server/
COPY --from=builder /app/mcp-server/dist ./mcp-server/dist
COPY --from=builder /app/mcp-client/package*.json ./mcp-client/
COPY --from=builder /app/mcp-client/dist ./mcp-client/dist

RUN cd mcp-server && npm ci --omit=dev
RUN cd mcp-client && npm ci --omit=dev --include=optional

WORKDIR /app/mcp-client

ENV NODE_ENV=production
ENV MCP_SERVER_COMMAND=node
ENV MCP_SERVER_ARGS=/app/mcp-server/dist/index.js

EXPOSE 3001
CMD ["node", "dist/index.js"]
