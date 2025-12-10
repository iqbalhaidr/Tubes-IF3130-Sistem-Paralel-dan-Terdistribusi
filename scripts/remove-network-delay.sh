#!/bin/bash
# Script to remove network delay from all Raft nodes

echo "Removing network delay from all Raft nodes..."

for node in node1 node2 node3 node4; do
    echo "Configuring $node..."
    docker exec raft-$node tc qdisc del dev eth0 root 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "  ✓ Network delay removed from $node"
    else
        echo "  ✓ No delay configured on $node (or already removed)"
    fi
done

echo ""
echo "Network delay removed from all nodes."
