FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .

# Generate Prisma client
RUN npx prisma generate

EXPOSE ${PORT:-4000}
CMD sh -c "npx prisma migrate deploy && node src/server.js"
