FROM node:22-alpine AS builder
WORKDIR /app/client
COPY client/package.json ./package.json
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build
