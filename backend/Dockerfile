FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .

# Generate Prisma client (after schema is copied)
RUN npx prisma generate


EXPOSE ${PORT:-4000}
CMD sh -c "npx prisma db push --skip-generate && node src/server.js"
