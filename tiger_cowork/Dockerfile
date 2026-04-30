# Stage 1: Build client
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install server deps
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# Install client deps
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install

# Copy source
COPY . .

# Build client
RUN cd client && npx vite build

# Stage 2: Production
# Debian-slim (glibc) instead of alpine (musl) — PyPI ships prebuilt wheels for
# numpy/scipy/matplotlib/pandas on glibc for both x86_64 and arm64, so pip
# install completes in seconds without needing a C toolchain in the image.
FROM node:20-bookworm-slim

WORKDIR /app

# Python 3 + venv + scientific stack from PyPI wheels (no source builds needed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir \
       numpy pillow matplotlib pandas openpyxl python-docx scipy seaborn

ENV PATH="/opt/venv/bin:$PATH"

# Install clawhub globally
RUN npm i -g clawhub

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --omit=dev && npm install tsx

# Copy server source + built client + data defaults
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/vite.config.* ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/data ./data

# Create upload directory
RUN mkdir -p uploads

EXPOSE 3001

ENV NODE_ENV=production

CMD ["npx", "tsx", "server/index.ts"]
