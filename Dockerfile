# Base compartida del servicio desplegable (Railway) y su compilación.
FROM node:22-slim AS base
WORKDIR /app

# Fuentes para el render de carruseles (autopost) con @napi-rs/canvas.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Respeta las versiones verificadas y todos los workspaces del lockfile.
FROM base AS build
COPY package.json package-lock.json ./
COPY packages/whatsapp-bot/package.json packages/whatsapp-bot/
RUN npm ci --workspaces --include-workspace-root --include=dev

# Código y build.
COPY . .
RUN npm run build --workspace packages/whatsapp-bot \
    && npm prune --omit=dev --workspaces --include-workspace-root

# La imagen final conserva assets, fuentes y binarios opcionales de canvas/resvg,
# sin arrastrar las capas con TypeScript, tsx ni herramientas de pruebas.
FROM base AS runtime
# CONTENEDOR-1: sin root. La app solo escribe en el tmpdir del sistema.
COPY --from=build --chown=node:node /app ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "packages/whatsapp-bot/dist/index.js"]
