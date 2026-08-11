FROM oven/bun:1.3.11-alpine@sha256:7ed9f74c326d1c260abe247ac423ccbf5ac92af62bb442d515d1f92f21e8ea9b

ARG TASQ_VERSION=0.0.0-source
ARG TASQ_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="Tasq Server" \
  org.opencontainers.image.description="Authenticated self-hosted Tasq coordination server" \
  org.opencontainers.image.source="https://github.com/gwendall/tasq" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="${TASQ_VERSION}" \
  org.opencontainers.image.revision="${TASQ_SOURCE_COMMIT}"

RUN bun install --global pnpm@10.29.3
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod

RUN addgroup -g 10001 -S tasq && adduser -u 10001 -S -G tasq -h /var/lib/tasq tasq \
  && mkdir -p /etc/tasq /var/lib/tasq \
  && chown -R tasq:tasq /etc/tasq /var/lib/tasq /app

USER tasq
EXPOSE 8787
VOLUME ["/var/lib/tasq"]
ENTRYPOINT ["bun", "/app/packages/tasq-server/src/daemon.ts"]
CMD ["serve", "--config", "/etc/tasq/server.json"]
