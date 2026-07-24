FROM oven/bun:1.3.11-alpine

RUN bun install --global pnpm@10.29.3
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod

RUN addgroup -S tasq && adduser -S -G tasq -h /var/lib/tasq tasq \
  && mkdir -p /etc/tasq /var/lib/tasq \
  && chown -R tasq:tasq /etc/tasq /var/lib/tasq /app

USER tasq
EXPOSE 8787
VOLUME ["/var/lib/tasq"]
ENTRYPOINT ["bun", "/app/packages/tasq-server/src/daemon.ts"]
CMD ["serve", "--config", "/etc/tasq/server.json"]
