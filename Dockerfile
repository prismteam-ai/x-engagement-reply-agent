# Dev image for running the agent in docker-compose (the `agent` profile).
# Production runs as a Lambda (see infra/) — this image is for local dev only.
FROM node:20-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Install deps first for layer caching. Secrets are NOT baked in — the agent
# reads credentials at runtime via env_file (.env) in docker-compose.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Default: poll on the configured schedule. Override in compose as needed.
CMD ["pnpm", "run", "run:watch"]
