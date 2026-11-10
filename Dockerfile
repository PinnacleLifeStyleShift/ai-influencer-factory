# ── Build stage ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# The API URL is compiled into the bundle and has no fallback, so the build
# fails rather than shipping a frontend that cannot reach its API.
ARG VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" >&2 && exit 1)
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── Serve stage ──
# `serve` comes from the lockfile (with its security overrides), not a global install.
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# WHY non-root: serving static files needs no privileges.
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/serve dist -s -l ${PORT:-3000}"]
