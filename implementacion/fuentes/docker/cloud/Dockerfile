# Imagen del servidor de la nube de odin-memory (`odin cloud serve`).
# Construcción: docker build -f docker/cloud/Dockerfile -t odin-cloud .
# Con un registro npm propio: --build-arg NPM_REGISTRY=https://<host>/repository/<grupo>/
FROM node:24-alpine AS deps
WORKDIR /app
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
RUN apk add --no-cache tzdata \
 && addgroup -S odin \
 && adduser -S -u 10001 -G odin odin
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY static ./static
ENV NODE_ENV=production
USER odin
EXPOSE 18080
ENTRYPOINT ["node", "bin/odin.js"]
CMD ["cloud", "serve"]
