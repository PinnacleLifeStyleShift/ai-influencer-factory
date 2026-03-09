FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .

# Generate Prisma client (after schema is copied)
RUN npx prisma generate

# Remove dev dependencies to slim down the image
RUN npm prune --production

EXPOSE ${PORT:-4000}
CMD sh -c "npx prisma migrate deploy && node src/server.js"
