FROM node:24-bookworm-slim AS sign-runtime
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY signs/requirements.txt signs/setup.sh ./signs/
RUN ./signs/setup.sh
COPY signs/recognize.py signs/arrows.py signs/routes.py signs/network.json ./signs/

FROM sign-runtime AS build
WORKDIR /app/backend
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS development
ENV API_PORT=8081 RECORDINGS_DIR=/data/recordings STATION_DIR=/data/station
COPY reconstruct.cjs ./
# Compose can run as the host UID while rebuilding the mounted TypeScript.
RUN chmod -R a+rwX dist
EXPOSE 8081
CMD ["sh", "-c", "npm run build && exec node dist/main.js"]

FROM sign-runtime
WORKDIR /app/backend
ENV NODE_ENV=production API_PORT=8081 RECORDINGS_DIR=/data/recordings STATION_DIR=/data/station
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY reconstruct.cjs ./
EXPOSE 8081
CMD ["node", "dist/main.js"]
