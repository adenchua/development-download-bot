# ---- Build stage ----
FROM node:24.14-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:24.14-alpine
WORKDIR /app

# Install Docker CLI (for docker pull / docker save / docker inspect / docker rmi)
RUN apk add --no-cache docker-cli

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p input output
CMD ["node", "dist/index.js"]
