# syntax=docker/dockerfile:1

# --- Build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 wird nativ kompiliert. Es wird nur noch vom Importer des
# Altbestandes gebraucht, bleibt aber im Abbild, bis der Umzug nach Postgres
# in der Produktion nachweislich durch ist.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
RUN npm ci

COPY . .
RUN npm run build

# Dev-Abhaengigkeiten nach dem Build entfernen.
RUN npm prune --omit=dev

# --- Laufzeit --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY --from=build /app/node_modules      ./node_modules
COPY --from=build /app/package.json      ./package.json
COPY --from=build /app/packages/shared/dist   ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist   ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/dist      ./packages/web/dist

# Schema und Startvorgang. `starten.mjs` wendet die Migrationen an, bevor der
# Server hochkommt, und `import-altbestand.mjs` liegt daneben, damit der
# einmalige Umzug im laufenden Container angestossen werden kann.
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
COPY --from=build /app/packages/server/scripts ./packages/server/scripts

# Zweitschrift der Belegdateien. Der Bestand selbst - Tabellen und Dateien -
# liegt seit der Umstellung vollstaendig in Postgres; dieses Verzeichnis haelt
# nur noch den Rueckweg auf eine aeltere Fassung offen.
#
# Bewusst KEIN VOLUME: Docker legt daraus bei jedem neuen Container ein neues
# anonymes Volume an, das beim naechsten Deploy stillschweigend verwaist - die
# Dateien waeren jedes Mal weg, ohne dass es jemand merkt. Das Verzeichnis muss
# ausdruecklich eingebunden werden (docker-compose.yml bzw. "Persistent
# Storage" in Coolify). Der Server warnt beim Start, wenn das fehlt.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/scripts/starten.mjs"]
