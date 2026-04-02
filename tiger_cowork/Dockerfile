# Stage 1: Build client
FROM node:20-alpine AS builder

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
FROM node:20-alpine

WORKDIR /app

# Install Python3 and required system libraries
RUN apk add --no-cache python3 py3-pip py3-numpy py3-pillow \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
       matplotlib pandas openpyxl python-docx scipy seaborn

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
