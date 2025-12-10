/**
 * Raft Server Entry Point
 * 
 * This is the main entry point for starting a Raft node server.
 * Configuration is loaded from environment variables.
 * 
 * Environment Variables:
 * - NODE_ID: Unique identifier for this node (default: "node1")
 * - PORT: Port to listen on (default: 3000)
 * - CLUSTER_NODES: Comma-separated list of nodes (e.g., "node1:3000,node2:3000")
 * - ELECTION_TIMEOUT_MIN: Minimum election timeout in ms (default: 150)
 * - ELECTION_TIMEOUT_MAX: Maximum election timeout in ms (default: 300)
 * - HEARTBEAT_INTERVAL: Heartbeat interval in ms (default: 50)
 * - LOG_LEVEL: Logging level (DEBUG, INFO, WARN, ERROR)
 * 
 * @module server
 */

import { loadConfig } from './config';
import { RaftNode } from './raft/node';
import { Logger } from './utils/logger';

const logger = new Logger('Server');

/**
 * Main entry point
 */
async function main(): Promise<void> {
    // Load configuration from environment
    const config = loadConfig();

    logger.info('Starting Raft Key-Value Store Server');
    logger.info(`Node ID: ${config.nodeId}`);
    logger.info(`Port: ${config.port}`);
    logger.info(`Cluster nodes: ${config.clusterNodes.map(n => `${n.id}:${n.port}`).join(', ')}`);
    logger.info(`Election timeout: ${config.electionTimeout[0]}-${config.electionTimeout[1]}ms`);
    logger.info(`Heartbeat interval: ${config.heartbeatInterval}ms`);

    // Create and start the Raft node
    const node = new RaftNode(config);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}, shutting down...`);
        await node.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled rejection:', reason);
    });

    // Start the node
    try {
        await node.start();
        logger.info('Server is running. Press Ctrl+C to stop.');
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Run main
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
