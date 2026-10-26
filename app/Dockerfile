# Tallybook runtime. Node 22.18+ runs TypeScript directly (type stripping), so there is no build step.
# Pinned to the 22.23 minor (22.23.4 on 2026-10-26) so type stripping can't regress; patch updates still flow.
FROM node:22.23-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/index.ts"]
