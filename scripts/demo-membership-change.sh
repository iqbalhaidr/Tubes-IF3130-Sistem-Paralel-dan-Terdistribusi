#!/bin/bash
# Membership Change Demonstration Script
# This script walks through the demonstration scenario step by step

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$SCRIPT_DIR/.."

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║         RAFT MEMBERSHIP CHANGE DEMONSTRATION                  ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Function to wait for user
wait_for_user() {
    echo ""
    read -p "Press Enter to continue..." _
    echo ""
}

# Check if cluster is running
if ! docker ps | grep -q "raft-node1"; then
    echo "Error: Raft cluster is not running."
    echo "Start with: cd docker && docker-compose up -d"
    exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "STEP 1: Add node5 as a new cluster member"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "This will:"
echo "  - Start a new container for node5"
echo "  - Add node5 to the cluster configuration"
echo "  - Wait for log replication to complete"
echo ""

wait_for_user

# Start node5 container
echo "Starting node5 container..."
"$SCRIPT_DIR/add-node.sh" node5 3005

echo ""
echo "Waiting 5 seconds for node5 to initialize..."
sleep 5

echo ""
echo "Now add node5 to the cluster. Run in another terminal:"
echo ""
echo "  docker-compose run --rm client"
echo "  raft> add_server node5 node5 3000"
echo ""
echo "Wait for log replication (watch logs with: docker-compose logs -f)"

wait_for_user

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "STEP 2: Send request_log to node5, then to leader"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Connect to node5 directly and request logs:"
echo ""
echo "  Terminal 1 (connect to node5):"
echo "    cd $PROJECT_DIR"
echo "    npm run start:client -- --server node5:3000"
echo "    raft> request_log"
echo ""
echo "  If redirected to leader, the response shows the leader's address."
echo "  Connect to leader and run request_log again."
echo ""

wait_for_user

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "STEP 3: Simultaneous operations"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Do these simultaneously in separate terminals:"
echo ""
echo "  Terminal 1 - Membership changes:"
echo "    raft> remove_server node4"
echo "    # Then start node6:"
echo "    $SCRIPT_DIR/add-node.sh node6 3006"
echo "    raft> add_server node6 node6 3000"
echo ""
echo "  Terminal 2 - Send requests to leader:"
echo "    raft> set crocodilo bombardino"
echo "    raft> set tung-tung-tung sahur"
echo ""
echo "The goal is to send requests while node6 is still syncing logs."
echo ""

wait_for_user

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "STEP 4: Verify logs on new node"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Connect to node6 and check logs:"
echo ""
echo "  npm run start:client -- --server node6:3000"
echo "  raft> request_log"
echo ""
echo "Then connect to leader:"
echo "  raft> request_log"
echo ""
echo "Compare the logs to see if replication is working correctly."
echo ""

wait_for_user

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "CLEANUP"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "To clean up the demo:"
echo ""
echo "  # Remove new nodes"
echo "  $SCRIPT_DIR/remove-node.sh node5"
echo "  $SCRIPT_DIR/remove-node.sh node6"
echo ""
echo "  # Or restart entire cluster"
echo "  cd docker && docker-compose down && docker-compose up -d"
echo ""
echo "Demonstration complete!"
