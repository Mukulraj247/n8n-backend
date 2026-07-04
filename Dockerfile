FROM node:20-bookworm-slim

WORKDIR /app

# Install app deps (skip the postinstall browser step; we do it explicitly below)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Install Chromium + all required system libraries for the pinned Playwright version
RUN npx playwright install --with-deps chromium

COPY . .

# Render injects PORT at runtime; the server falls back to 8787 locally.
ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/server.js"]
