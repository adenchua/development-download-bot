# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:24-alpine
WORKDIR /app

# Install Docker CLI and curl, then download the Copa binary for image hardening.
ARG COPA_VERSION=0.14.1
RUN apk add --no-cache docker-cli curl \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && curl -fsSL "https://github.com/project-copacetic/copacetic/releases/download/v${COPA_VERSION}/copa_${COPA_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin copa

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p input output

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app
USER appuser

CMD ["node", "dist/index.js"]
