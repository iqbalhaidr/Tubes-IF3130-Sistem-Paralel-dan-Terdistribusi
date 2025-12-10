#!/bin/bash
# Script to add a new node container to the Raft cluster
# Usage: ./add-node.sh <node-id> [port]
# Example: ./add-node.sh node5 3005

if [ -z "$1" ]; then
    echo "Usage: ./add-node.sh <node-id> [external-port]"
    echo "Example: ./add-node.sh node5 3005"
    exit 1
fi

NODE_ID=$1
EXTERNAL_PORT=${2:-3005}
INTERNAL_PORT=3000

# Get the network name (docker directory prefix + raft-network)
NETWORK_NAME=$(docker network ls --filter "name=raft-network" --format "{{.Name}}" | head -1)

if [ -z "$NETWORK_NAME" ]; then
    echo "Error: raft-network not found. Is the cluster running?"
    echo "Run: cd docker && docker-compose up -d"
    exit 1
fi

echo "Starting new node: $NODE_ID"
echo "Network: $NETWORK_NAME"
echo "External port: $EXTERNAL_PORT"
echo ""

# Get the project directory
PROJECT_DIR="$(dirname "$0")/.."

# Always rebuild to ensure latest code
echo "Building Docker image with latest code..."
docker build -t raft-kv-store -f "$PROJECT_DIR/docker/Dockerfile" "$PROJECT_DIR"

if [ $? -ne 0 ]; then
    echo "✗ Failed to build Docker image"
    exit 1
fi

# Stop and remove if already exists
docker stop "raft-$NODE_ID" 2>/dev/null
docker rm "raft-$NODE_ID" 2>/dev/null

# Start the new node container
# JOIN_MODE=true prevents the node from starting elections until added via add_server
# New nodes only know about existing cluster, not themselves yet
# --hostname is required for DNS resolution within Docker network
docker run -d \
    --name "raft-$NODE_ID" \
    --hostname "$NODE_ID" \
    --network "$NETWORK_NAME" \
    -e NODE_ID="$NODE_ID" \
    -e PORT=$INTERNAL_PORT \
    -e CLUSTER_NODES="node1:3000,node2:3000,node3:3000,node4:3000" \
    -e JOIN_MODE=true \
    -e LOG_LEVEL=INFO \
    -p "$EXTERNAL_PORT:$INTERNAL_PORT" \
    --cap-add NET_ADMIN \
    --restart on-failure \
    raft-kv-store

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Node $NODE_ID started successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Add network delay (optional):"
    echo "   docker exec raft-$NODE_ID tc qdisc add dev eth0 root netem delay 100ms 50ms"
    echo ""
    echo "2. Add to cluster via CLI:"
    echo "   raft> add_server $NODE_ID $NODE_ID 3000"
    echo ""
    echo "3. Connect client directly to this node:"
    echo "   npm run start:client -- --server $NODE_ID:3000"
else
    echo "✗ Failed to start node $NODE_ID"
    exit 1
fi
