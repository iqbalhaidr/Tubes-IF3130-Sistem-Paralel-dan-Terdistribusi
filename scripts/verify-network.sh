#!/bin/bash
# Script to verify network connectivity and delay between nodes

echo "Verifying network connectivity between Raft nodes..."
echo "=================================================="
echo ""

# Check connectivity from node1 to other nodes
echo "Ping from node1 to other nodes (5 packets each):"
echo ""

for target in node2 node3 node4; do
    echo "--- node1 -> $target ---"
    docker exec raft-node1 ping -c 5 $target 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "  ✗ Failed to ping $target from node1"
    fi
    echo ""
done

echo "=================================================="
echo "Network verification complete."
echo ""
echo "If you see ~100ms delay with variation, network delay is configured."
echo "If you see <1ms delay, run ./scripts/add-network-delay.sh first."
