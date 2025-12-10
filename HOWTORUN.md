# How to Run - Raft Key-Value Store

This guide explains how to set up, build, and run the Raft distributed key-value store for development and demonstration.

## Prerequisites

- **Node.js 20+** (for local development)
- **npm** (comes with Node.js)
- **Docker & Docker Compose** (for cluster demonstration)

## Quick Start

### Option 1: Docker Cluster (Recommended for Demo)

```bash
# 1. Build and start the 4-node cluster
cd docker
docker-compose up --build -d

# 2. Wait for nodes to start (10-15 seconds)
sleep 15

# 3. Add network delay (simulates real network conditions)
chmod +x ../scripts/*.sh
../scripts/add-network-delay.sh

# 4. Verify network delay is working
../scripts/verify-network.sh

# 5. Run the client CLI
docker-compose run --rm client

# 6. In the CLI, try commands:
#    ping
#    set mykey hello
#    get mykey
#    request_log
```

### Option 2: Local Development

```bash
# 1. Install dependencies
npm install

# 2. Build the project
npm run build

# 3. Run a single node
NODE_ID=node1 PORT=3000 npm start

# 4. In another terminal, run the client
npm run start:client -- --server localhost:3000
```

## Project Structure

```
├── src/
│   ├── rpc/          # RPC system (JSON-RPC over HTTP)
│   ├── raft/         # Raft consensus protocol
│   ├── store/        # Key-Value store
│   ├── client/       # CLI client
│   ├── utils/        # Utilities (logger)
│   ├── config.ts     # Configuration
│   └── server.ts     # Server entry point
├── tests/            # Unit tests
├── docker/           # Docker configuration
├── scripts/          # Helper scripts
└── package.json
```

## Available Commands

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Start a Raft node server |
| `npm run start:client` | Start the CLI client |
| `npm run dev` | Start server with ts-node (no build) |
| `npm run dev:client` | Start client with ts-node |
| `npm test` | Run unit tests |
| `npm run test:coverage` | Run tests with coverage report |

### Client CLI Commands

| Command | Description | Example |
|---------|-------------|---------|
| `ping` | Check connection | `ping` → `PONG` |
| `get <key>` | Get value | `get name` → `"John"` |
| `set <key> <value>` | Set value | `set name John` → `OK` |
| `strln <key>` | Get string length | `strln name` → `4` |
| `del <key>` | Delete key | `del name` → `"John"` |
| `append <key> <value>` | Append to value | `append name Doe` → `OK` |
| `request_log` | Get leader's log | Shows log entries |
| `add_server <id> <addr> <port>` | Add node to cluster | `add_server node5 node5 3000` |
| `remove_server <id>` | Remove node from cluster | `remove_server node4` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ID` | `node1` | Unique node identifier |
| `PORT` | `3000` | RPC server port |
| `CLUSTER_NODES` | `node1:3000` | Comma-separated list of nodes |
| `ELECTION_TIMEOUT_MIN` | `150` | Min election timeout (ms) |
| `ELECTION_TIMEOUT_MAX` | `300` | Max election timeout (ms) |
| `HEARTBEAT_INTERVAL` | `50` | Heartbeat interval (ms) |
| `LOG_LEVEL` | `DEBUG` | Logging level (DEBUG/INFO/WARN/ERROR) |

## Docker Commands

### Start Cluster
```bash
cd docker
docker-compose up --build -d
```

### View Logs
```bash
# All nodes
docker-compose logs -f

# Specific node
docker logs -f raft-node1
```

### Stop Cluster
```bash
docker-compose down
```

### Restart a Node (Simulate Failure/Recovery)
```bash
docker restart raft-node2
```

### Execute Commands in Container
```bash
docker exec -it raft-node1 sh
```

## Demonstration Steps

### 1. Start the Cluster
```bash
cd docker
docker-compose up --build -d
sleep 15  # Wait for election
```

### 2. Add Network Delay
```bash
../scripts/add-network-delay.sh
../scripts/verify-network.sh
```

### 3. Run Client Tests
```bash
docker-compose run --rm client
# In CLI:
raft> ping
PONG
raft> set user alice
OK
raft> get user
"alice"
```

### 4. Test Leader Failover
```bash
# Find current leader (look at logs)
docker-compose logs | grep "became leader"

# Kill the leader
docker stop raft-node1

# Wait for new election (~500ms)
sleep 1

# Client should still work (redirect to new leader)
docker-compose run --rm client
raft> ping
PONG
```

### 5. Test Membership Change
```bash
# In client CLI:
raft> add_server node5 node5 3000
OK
raft> remove_server node4
OK
```

## Troubleshooting

### Port Already in Use
```bash
# Check what's using port 3000
lsof -i :3000
# Kill the process or use different ports
```

### Docker Network Issues
```bash
# Recreate network
docker-compose down
docker network rm docker_raft-network
docker-compose up --build -d
```

### Container Won't Start
```bash
# Check container logs
docker logs raft-node1
# Rebuild without cache
docker-compose build --no-cache
```

## Team Member Responsibilities

### Person 1 (Implemented Here)
- ✅ RPC system (`src/rpc/`)
- ✅ Client CLI (`src/client/cli.ts`)
- ✅ Membership change (`handleAddServer`, `handleRemoveServer` in `RaftNode`)

### Person 2 (TODO)
- Leader election logic (enhance `startElection`, `handleRequestVote`)
- Timer management (election timeouts)
- State transition logic

### Person 3 (TODO)
- Log replication (implement `handleAppendEntries` fully)
- Key-value store integration with log
- Commit logic (majority acknowledgment)

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- tests/rpc.test.ts

# Watch mode
npm run test:watch
```
