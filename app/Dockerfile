# Tallybook runtime. Node 22.18+ runs TypeScript directly (type stripping), so there is no build step.
FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/index.ts"]
