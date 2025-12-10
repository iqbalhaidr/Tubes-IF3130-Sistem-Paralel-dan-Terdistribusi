#!/bin/bash
# Script to remove a node container from the cluster
# Usage: ./remove-node.sh <node-id>
#        ./remove-node.sh --all  (removes node5, node6, etc.)
# Example: ./remove-node.sh node5

if [ -z "$1" ]; then
    echo "Usage: ./remove-node.sh <node-id>"
    echo "       ./remove-node.sh --all  (removes node5, node6, etc.)"
    exit 1
fi

if [ "$1" == "--all" ]; then
    echo "Removing all dynamically added nodes (node5+)..."
    for i in 5 6 7 8 9; do
        docker stop "raft-node$i" 2>/dev/null && echo "Stopped raft-node$i"
        docker rm "raft-node$i" 2>/dev/null && echo "Removed raft-node$i"
    done
    echo "Done!"
    exit 0
fi

NODE_ID=$1

echo "Stopping and removing node: $NODE_ID"

docker stop "raft-$NODE_ID" 2>/dev/null
docker rm "raft-$NODE_ID" 2>/dev/null

echo "✓ Node $NODE_ID container removed"
echo ""
echo "Note: To also remove from cluster configuration, run in CLI:"
echo "   raft> remove_server $NODE_ID"
