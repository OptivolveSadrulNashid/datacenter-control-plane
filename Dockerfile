# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM base AS runtime
ENV NODE_ENV=production
# From `build`, not `deps`: that is the stage where `prisma generate` wrote the
# generated client into node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY prisma ./prisma
# Kept so `npm run seed` (which runs the TS entrypoint via tsx) works in-container.
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
