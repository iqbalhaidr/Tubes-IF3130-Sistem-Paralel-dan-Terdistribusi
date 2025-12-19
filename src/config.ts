/**
 * Configuration module for the Raft Key-Value Store, handles loading configuration from environment variables
 * and provides default values for local development.
 * 
 * @module config
 */

/**
 * Server information for a node in the Raft cluster
 */
export interface ServerInfo {
    id: string;
    address: string;
    port: number;
}

/**
 * Configuration for the Raft node
 */
export interface RaftConfig {
    nodeId: string;
    port: number;
    clusterNodes: ServerInfo[];
    electionTimeout: [number, number];
    heartbeatInterval: number;
    joinMode: boolean;
}

/**
 * Parse cluster nodes from environment variable
 * Format: "node1:3000,node2:3000,node3:3000,node4:3000"
 * 
 * @param clusterNodesStr - Comma-separated list of node:port pairs
 * @returns Array of ServerInfo objects
 */
function parseClusterNodes(clusterNodesStr: string): ServerInfo[] {
    if (!clusterNodesStr) {
        return [];
    }

    return clusterNodesStr.split(',').map((nodeStr, index) => {
        const [address, portStr] = nodeStr.trim().split(':');
        const port = parseInt(portStr, 10) || 3000;
        // Generate node ID from the address (e.g., "node1" from "node1:3000")
        const id = address.includes('.') ? `node${index + 1}` : address;

        return { id, address, port };
    });
}

/**
 * Load configuration from environment variables with default values
 * 
 * @returns RaftConfig object with loaded configuration
 */
export function loadConfig(): RaftConfig {
    const nodeId = process.env.NODE_ID || 'node1';
    const port = parseInt(process.env.PORT || '3000', 10);

    // Default cluster
    const defaultCluster = `${nodeId}:${port}`;
    const clusterNodesStr = process.env.CLUSTER_NODES || defaultCluster;
    const clusterNodes = parseClusterNodes(clusterNodesStr);

    // Election timeout randomized between min and max
    const electionTimeoutMin = parseInt(process.env.ELECTION_TIMEOUT_MIN || '150', 10);
    const electionTimeoutMax = parseInt(process.env.ELECTION_TIMEOUT_MAX || '300', 10);

    const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || '50', 10);

    // if true join mode, this node is being added dynamically and should not vote/elect
    const joinMode = process.env.JOIN_MODE === 'true';

    return {
        nodeId,
        port,
        clusterNodes,
        electionTimeout: [electionTimeoutMin, electionTimeoutMax],
        heartbeatInterval,
        joinMode,
    };
}

/**
 * Get a random election timeout within the configured range
 * 
 * @param config - Raft configuration
 * @returns Random timeout value in milliseconds
 */
export function getRandomElectionTimeout(config: RaftConfig): number {
    const [min, max] = config.electionTimeout;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Find server info by ID
 * 
 * @param config - Raft configuration
 * @param serverId - Server ID to find
 * @returns ServerInfo if found, undefined otherwise
 */
export function findServerById(config: RaftConfig, serverId: string): ServerInfo | undefined {
    return config.clusterNodes.find(node => node.id === serverId);
}

/**
 * Get the URL for a server's RPC endpoint
 * 
 * @param server - Server info
 * @returns Full URL for RPC endpoint
 */
export function getServerUrl(server: ServerInfo): string {
    return `http://${server.address}:${server.port}/rpc`;
}
