FROM node:22-alpine AS frontend
WORKDIR /app/client
COPY client/package.json ./package.json
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:22.12-alpine3.21
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY . /app
COPY --from=frontend /app/server-node/static/ /app/server-node/static/
WORKDIR /app/server-node
RUN npm install --no-audit --no-fund
EXPOSE 9501
CMD ["node", "main.js"]
