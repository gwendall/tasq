FROM node:22.18.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml bunfig.toml ./
COPY packages/tasq-schema/package.json packages/tasq-schema/package.json
COPY packages/tasq-cloud-control-plane/package.json packages/tasq-cloud-control-plane/package.json
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate && \
    pnpm install --frozen-lockfile --filter @tasq-internal/cloud-control-plane...

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/tasq-schema/node_modules /app/packages/tasq-schema/node_modules
COPY --from=dependencies /app/packages/tasq-cloud-control-plane/node_modules /app/packages/tasq-cloud-control-plane/node_modules
COPY packages/tasq-schema packages/tasq-schema
COPY packages/tasq-cloud-control-plane packages/tasq-cloud-control-plane
USER bun
WORKDIR /app/packages/tasq-cloud-control-plane
CMD ["bun", "src/runtime.ts"]
