# ── Build stage ──
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ── Serve stage ──
FROM node:20-alpine AS production
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/dist ./dist
EXPOSE ${PORT:-3000}
CMD sh -c "serve dist -s -l ${PORT:-3000}"
