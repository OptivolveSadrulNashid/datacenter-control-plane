# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# `npm run build` typechecks first, so a type error fails the image build rather
# than shipping a broken bundle.
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# No API URL is baked into the bundle: the app calls relative /api paths and
# nginx forwards them, so this image is identical in every environment.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
