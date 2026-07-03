FROM node:24-slim AS build

WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN pnpm run build
RUN pnpm prune --prod

FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations

USER node
EXPOSE 4000

CMD ["sh", "-c", "node --env-file-if-exists=.env dist/scripts/migrate.js && node dist/main.js"]
