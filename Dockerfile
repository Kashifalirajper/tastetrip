# TasteTrip runs as a long-lived container: Qloo's MCP server (`qloo mcp`)
# is a local stdio process, so serverless functions are not supported.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN useradd --create-home app && chown -R app /app
USER app
ENV PORT=3000 QLOO_HOME=/home/app/.qloo
EXPOSE 3000
CMD ["node", "server.js"]
