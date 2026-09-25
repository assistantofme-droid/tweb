# 7eve9Chat web, served at /web-k/ by nginx, which also passes /web-k/api,
# /web-k/uploads and /web-k/socket.io on to the 7eve9Chat backend.
#
#   docker compose -f deploy/web-k/docker-compose.yml up -d --build
#
# Docker Hub or npm unreachable from the server? Point the build arguments at
# a mirror (see docker-compose.yml).

ARG NODE_IMAGE=node:24
ARG NGINX_IMAGE=nginx:stable-alpine

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
RUN npm install -g pnpm@11.16.0 --registry=$NPM_REGISTRY
COPY . .
RUN pnpm install --frozen-lockfile --registry=$NPM_REGISTRY

# where public links point / where the browser reaches the backend
ARG SEVEN_NINE_SITE=https://7eve9craft.ir
ARG SEVEN_NINE_ORIGIN=/web-k
RUN VITE_SEVEN_NINE_SITE=$SEVEN_NINE_SITE VITE_SEVEN_NINE_ORIGIN=$SEVEN_NINE_ORIGIN pnpm exec vite build \
  && node deploy/web-k/assemble.js /out

FROM ${NGINX_IMAGE}
COPY --from=build /out /usr/share/nginx/html/web-k
COPY deploy/web-k/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
