# syntax=docker/dockerfile:1
# One image: API + web app + worker (ROLE=app | worker | all)
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root=false

FROM node:22-alpine
RUN apk add --no-cache postgresql16-client tini
ENV NODE_ENV=production PORT=8080 VAULTS_ROOT=/vaults DATA_DIR=/data WEB_DIST=/app/web
WORKDIR /app/api
COPY --from=deps /src/node_modules /app/node_modules
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/api/drizzle ./drizzle
COPY --from=build /src/apps/api/package.json ./
COPY --from=build /src/apps/web/dist /app/web
RUN mkdir -p /vaults /data && chown node:node /vaults /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
