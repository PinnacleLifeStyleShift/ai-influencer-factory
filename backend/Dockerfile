FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .

# Generate Prisma client (after schema is copied)
RUN npx prisma generate


EXPOSE ${PORT:-4000}
# Apply committed migrations (verified baseline for pre-migration databases),
# then start. No schema push at build or start.
CMD ["npm", "start"]
