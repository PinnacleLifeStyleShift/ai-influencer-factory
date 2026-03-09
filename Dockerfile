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
ENV PORT=3000
EXPOSE 3000
CMD ["serve", "dist", "-s", "-l", "3000"]
