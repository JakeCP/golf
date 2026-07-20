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

COPY tsconfig.json process-queue.ts entrypoint.sh merge-queue.js ./
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
