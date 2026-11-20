FROM node:24-bookworm-slim AS build
WORKDIR /app/backend
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS development
ENV API_PORT=8081 RECORDINGS_DIR=/data/recordings
COPY reconstruct.cjs ./
# Compose can run as the host UID while rebuilding the mounted TypeScript.
RUN chmod -R a+rwX dist
EXPOSE 8081
CMD ["sh", "-c", "npm run build && exec node dist/main.js"]

FROM node:24-bookworm-slim
WORKDIR /app/backend
ENV NODE_ENV=production API_PORT=8081 RECORDINGS_DIR=/data/recordings
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY reconstruct.cjs ./
EXPOSE 8081
CMD ["node", "dist/main.js"]
