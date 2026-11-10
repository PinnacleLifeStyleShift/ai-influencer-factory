FROM node:22-alpine

# WHY non-root: the API needs no privileges; a compromise of the process then
# cannot modify the image's files or install software.
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node . .

# Generate Prisma client (after schema is copied)
RUN npx prisma generate

ENV NODE_ENV=production
EXPOSE ${PORT:-4000}
# Apply committed migrations (verified baseline for pre-migration databases),
# then start. No schema push at build or start.
CMD ["npm", "start"]
