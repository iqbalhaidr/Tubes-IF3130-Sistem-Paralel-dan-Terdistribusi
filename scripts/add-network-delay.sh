#!/bin/bash
# Script to add network delay to all Raft nodes
# This simulates real network conditions for demonstration

# Network delay parameters (from specification)
# delay 100ms 50ms - adds 100ms delay with 50ms jitter
# reorder 8% - 8% of packets may be reordered
# corrupt 5% - 5% of packets may be corrupted
# duplicate 2% 5% - 2% chance of duplication with 5% correlation
# loss 5% - 5% packet loss

echo "Adding network delay to all Raft nodes..."

# Add delay to each node
for node in node1 node2 node3 node4; do
    echo "Configuring $node..."
    docker exec raft-$node tc qdisc add dev eth0 root netem \
        delay 100ms 50ms \
        reorder 8% \
        corrupt 5% \
        duplicate 2% 5% \
        loss 5%
    
    if [ $? -eq 0 ]; then
        echo "  ✓ Network delay added to $node"
    else
        echo "  ✗ Failed to add delay to $node"
    fi
done

echo ""
echo "Network delay configuration complete!"
echo ""
echo "To verify the delay, run:"
echo "  docker exec raft-node1 ping -c 5 node2"
