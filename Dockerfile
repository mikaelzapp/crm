# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update; \
    else apt-get update; fi \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --strict-ssl=true

FROM dependencies AS builder
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run build

FROM builder AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund \
    && mkdir -p /opt/crm-runtime/.next \
    && cp -a .next/standalone/. /opt/crm-runtime/ \
    && cp -a node_modules /opt/crm-runtime/ \
    && cp -a .next/static /opt/crm-runtime/.next/static \
    && cp -a prisma src scripts public tsconfig.json package.json /opt/crm-runtime/ \
    && chmod 0555 /opt/crm-runtime/scripts/entrypoint.sh

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=production-dependencies --chown=node:node /opt/crm-runtime/ ./
USER node
EXPOSE 3000
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["web"]
