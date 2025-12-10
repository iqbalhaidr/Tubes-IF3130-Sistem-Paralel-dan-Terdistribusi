# Use Node.js 20 Alpine image for smaller size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install iproute2 for tc command (network delay simulation)
# and curl for health checks
RUN apk add --no-cache iproute2 curl

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose the RPC port
EXPOSE 3000

# Default command - can be overridden in docker-compose
CMD ["node", "dist/server.js"]
