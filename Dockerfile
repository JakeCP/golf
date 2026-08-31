FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# git is needed at runtime by entrypoint.sh to clone the queue state and
# push updates back. Playwright base image is Ubuntu so apt is available.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Ensure the Chromium binary matches the @playwright/test version installed
# above (the base image's preinstalled browser may not match if package-lock
# pins a different minor).
RUN npx playwright install chromium

# Copy every source module, not just the entrypoint script: process-queue.ts
# imports sibling modules (e.g. ./api-availability), and listing files one by
# one means a new module silently breaks the image at runtime. Test files come
# along too but are never loaded - ts-node only compiles what is required.
COPY tsconfig.json *.ts entrypoint.sh ./
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
