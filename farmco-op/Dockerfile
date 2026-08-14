FROM node:20-slim

WORKDIR /app

# Install dependencies first (better layer caching on rebuilds)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Runtime data (SQLite db + uploaded avatars) lives on the mounted volume,
# not baked into the image — see fly.toml's [mounts] section.
RUN mkdir -p /app/data /app/public/uploads/avatars

EXPOSE 3000
CMD ["node", "server/index.js"]
