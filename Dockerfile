FROM node:22-alpine AS build
# better-sqlite3 falls back to a source build when no prebuilt binary matches
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3100 DATABASE_PATH=/app/data/posts.db
EXPOSE 3100
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
