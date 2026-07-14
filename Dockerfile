# PlayMCP in KC 배포용 — 반드시 linux/amd64 로 빌드할 것
# (Apple Silicon: docker build --platform linux/amd64 ...)
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/build ./build
EXPOSE 8080
CMD ["node", "build/index.js"]
