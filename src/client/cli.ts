/**
 * Client CLI Module
 * 
 * This module provides an interactive command-line interface for users to
 * interact with the Raft key-value store cluster.
 * 
 * Features:
 * - Execute commands (ping, get, set, strln, del, append)
 * - Request log from leader
 * - Add/Remove servers from cluster
 * - Automatic leader redirect if contacting follower
 * 
 * @module client/cli
 */

import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    ExecuteResponse,
    RequestLogResponse,
    AddServerResponse,
    RemoveServerResponse,
    RPC_ERROR_CODES,
} from '../rpc/types';
import { ServerInfo } from '../config';

// ============================================================================
// Configuration
// ============================================================================

/** Default servers to try connecting to */
const DEFAULT_SERVERS: ServerInfo[] = [
    { id: 'node1', address: 'node1', port: 3000 },
    { id: 'node2', address: 'node2', port: 3000 },
    { id: 'node3', address: 'node3', port: 3000 },
    { id: 'node4', address: 'node4', port: 3000 },
];

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT = 5000;

// ============================================================================
// ANSI Colors for terminal output
// ============================================================================

const COLORS = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

// ============================================================================
// HTTP Client for JSON-RPC
// ============================================================================

/**
 * Make an HTTP POST request with JSON body
 * 
 * @param url - Target URL
 * @param body - JSON body
 * @param timeout - Request timeout in ms
 * @returns Parsed JSON response
 */
function httpPost(url: string, body: string, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);

        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 80,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout,
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(body);
        req.end();
    });
}

// ============================================================================
// Client Class
// ============================================================================

/**
 * Raft Client for interacting with the cluster
 * 
 * Handles:
 * - Sending commands to the cluster
 * - Automatic leader discovery and redirect
 * - Caching known leader for efficiency
 */
export class RaftClient {
    /** Known servers in the cluster */
    private servers: ServerInfo[];
    /** Cached leader address (for efficiency) */
    private cachedLeader: ServerInfo | null = null;
    /** Debug mode for verbose logging */
    private debug: boolean;

    constructor(servers?: ServerInfo[], debug = false) {
        this.servers = servers || DEFAULT_SERVERS;
        this.debug = debug;
    }

    /**
     * Log a debug message
     */
    private log(message: string): void {
        if (this.debug) {
            console.log(`${COLORS.gray}[DEBUG] ${message}${COLORS.reset}`);
        }
    }

    /**
     * Get the URL for a server's RPC endpoint
     */
    private getServerUrl(server: ServerInfo): string {
        return `http://${server.address}:${server.port}/rpc`;
    }

    /**
     * Create a JSON-RPC request
     */
    private createRequest(method: string, params?: any): JsonRpcRequest {
        return {
            jsonrpc: '2.0',
            method,
            params,
            id: uuidv4(),
        };
    }

    /**
     * Send a JSON-RPC request to a server
     * 
     * @param server - Target server
     * @param request - JSON-RPC request
     * @returns JSON-RPC response
     */
    private async sendRequest(server: ServerInfo, request: JsonRpcRequest): Promise<JsonRpcResponse> {
        const url = this.getServerUrl(server);
        const body = JSON.stringify(request);

        this.log(`Sending ${request.method} to ${server.id} (${url})`);

        try {
            const response = await httpPost(url, body, REQUEST_TIMEOUT);
            return response as JsonRpcResponse;
        } catch (error) {
            this.log(`Failed to connect to ${server.id}: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Parse server address string to ServerInfo
     * Format: "host:port" or just "host" (uses default port 3000)
     */
    private parseServerAddress(address: string): ServerInfo {
        const parts = address.split(':');
        const host = parts[0];
        const port = parts[1] ? parseInt(parts[1], 10) : 3000;
        return {
            id: host,
            address: host,
            port,
        };
    }

    /**
     * Find a working server to send requests to
     * Uses cached leader if available, otherwise tries all known servers
     * 
     * @returns Working server or null if none found
     */
    private async findWorkingServer(): Promise<ServerInfo | null> {
        // Try cached leader first
        if (this.cachedLeader) {
            try {
                const request = this.createRequest('execute', { command: 'ping', args: [] });
                const response = await this.sendRequest(this.cachedLeader, request);

                if ('result' in response && response.result.success) {
                    return this.cachedLeader;
                }

                // Check if we got a redirect
                if ('result' in response && response.result.leaderId && response.result.leaderAddress) {
                    this.cachedLeader = this.parseServerAddress(response.result.leaderAddress);
                    return this.cachedLeader;
                }
            } catch {
                // Cached leader not responding, try others
                this.cachedLeader = null;
            }
        }

        // Try all known servers
        for (const server of this.servers) {
            try {
                const request = this.createRequest('execute', { command: 'ping', args: [] });
                const response = await this.sendRequest(server, request);

                if ('result' in response) {
                    if (response.result.success) {
                        this.cachedLeader = server;
                        return server;
                    }

                    // Got a redirect to the actual leader
                    if (response.result.leaderAddress) {
                        this.cachedLeader = this.parseServerAddress(response.result.leaderAddress);
                        return this.cachedLeader;
                    }
                }
            } catch {
                // Server not responding, try next
                continue;
            }
        }

        return null;
    }

    /**
     * Send a command to the cluster with automatic leader redirect
     * 
     * @param method - RPC method name
     * @param params - Method parameters
     * @param maxRedirects - Maximum number of redirects to follow
     * @returns Response from the leader
     */
    private async sendWithRedirect<T extends { success: boolean; leaderId: string | null; leaderAddress?: string }>(
        method: string,
        params: any,
        maxRedirects = 3
    ): Promise<T> {
        let currentServer = this.cachedLeader || this.servers[0];
        let redirectCount = 0;

        while (redirectCount < maxRedirects) {
            try {
                const request = this.createRequest(method, params);
                const response = await this.sendRequest(currentServer, request);

                // Handle RPC error
                if ('error' in response) {
                    // Check if it's a "not leader" error with redirect info
                    if (response.error.code === RPC_ERROR_CODES.NOT_LEADER &&
                        response.error.data?.leaderAddress) {
                        this.log(`Redirecting to leader at ${response.error.data.leaderAddress}`);
                        currentServer = this.parseServerAddress(response.error.data.leaderAddress);
                        this.cachedLeader = currentServer;
                        redirectCount++;
                        continue;
                    }
                    throw new Error(response.error.message);
                }

                const result = response.result as T;

                // Check if response indicates we need to redirect
                if (!result.success && result.leaderAddress) {
                    this.log(`Redirecting to leader at ${result.leaderAddress}`);
                    currentServer = this.parseServerAddress(result.leaderAddress);
                    this.cachedLeader = currentServer;
                    redirectCount++;
                    continue;
                }

                // Success! Cache the leader
                if (result.success && result.leaderId) {
                    this.cachedLeader = currentServer;
                }

                return result;

            } catch (error) {
                // Connection error, try next server
                this.log(`Error: ${(error as Error).message}`);

                // Try the next server in the list
                const currentIndex = this.servers.findIndex(s => s.id === currentServer.id);
                const nextIndex = (currentIndex + 1) % this.servers.length;
                currentServer = this.servers[nextIndex];
                redirectCount++;
            }
        }

        throw new Error('Failed to connect to cluster after maximum redirects');
    }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * Execute a key-value store command
     * 
     * @param command - Command to execute (ping, get, set, strln, del, append)
     * @param args - Command arguments
     * @returns Command result
     */
    async execute(command: string, args: string[]): Promise<ExecuteResponse> {
        return this.sendWithRedirect<ExecuteResponse>('execute', { command, args });
    }

    /**
     * Request the leader's log
     * 
     * @returns Log entries from the leader
     */
    async requestLog(): Promise<RequestLogResponse> {
        return this.sendWithRedirect<RequestLogResponse>('request_log', {});
    }

    /**
     * Add a new server to the cluster
     * 
     * @param serverId - New server ID
     * @param address - New server address
     * @param port - New server port
     * @returns Add server response
     */
    async addServer(serverId: string, address: string, port: number): Promise<AddServerResponse> {
        const newServer: ServerInfo = { id: serverId, address, port };
        return this.sendWithRedirect<AddServerResponse>('add_server', { newServer });
    }

    /**
     * Remove a server from the cluster
     * 
     * @param serverId - Server ID to remove
     * @returns Remove server response
     */
    async removeServer(serverId: string): Promise<RemoveServerResponse> {
        return this.sendWithRedirect<RemoveServerResponse>('remove_server', { serverId });
    }

    /**
     * Add a known server to the client's server list
     * 
     * @param server - Server info to add
     */
    addKnownServer(server: ServerInfo): void {
        if (!this.servers.find(s => s.id === server.id)) {
            this.servers.push(server);
        }
    }

    /**
     * Clear cached leader (force re-discovery)
     */
    clearLeaderCache(): void {
        this.cachedLeader = null;
    }
}

// ============================================================================
// Interactive CLI
// ============================================================================

/**
 * Print help message
 */
function printHelp(): void {
    console.log(`
${COLORS.cyan}Raft Key-Value Store Client${COLORS.reset}
${COLORS.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}

${COLORS.yellow}Commands:${COLORS.reset}
  ${COLORS.green}ping${COLORS.reset}                      Check connection to the server
  ${COLORS.green}get${COLORS.reset} <key>                 Get value for key
  ${COLORS.green}set${COLORS.reset} <key> <value>         Set key to value
  ${COLORS.green}strln${COLORS.reset} <key>               Get string length of value
  ${COLORS.green}del${COLORS.reset} <key>                 Delete key and return value
  ${COLORS.green}append${COLORS.reset} <key> <value>      Append to value
  
${COLORS.yellow}Cluster Management:${COLORS.reset}
  ${COLORS.green}request_log${COLORS.reset}               Get the leader's log
  ${COLORS.green}add_server${COLORS.reset} <id> <addr> <port>  Add a new server
  ${COLORS.green}remove_server${COLORS.reset} <id>        Remove a server
  
${COLORS.yellow}Client Commands:${COLORS.reset}
  ${COLORS.green}connect${COLORS.reset} <addr:port>       Add a server to connect to
  ${COLORS.green}debug${COLORS.reset}                     Toggle debug mode
  ${COLORS.green}help${COLORS.reset}                      Show this help message
  ${COLORS.green}exit${COLORS.reset}                      Exit the CLI
`);
}

/**
 * Format and print a response
 */
function printResponse(response: any): void {
    if (response.success !== undefined && !response.success) {
        console.log(`${COLORS.red}Error: ${response.error || 'Command failed'}${COLORS.reset}`);
        if (response.leaderId) {
            console.log(`${COLORS.yellow}Leader: ${response.leaderId} (${response.leaderAddress || 'unknown'})${COLORS.reset}`);
        }
        return;
    }

    if (response.result !== undefined) {
        console.log(response.result);
    } else if (response.log !== undefined) {
        console.log(`${COLORS.cyan}Log entries (${response.log.length}):${COLORS.reset}`);
        for (const entry of response.log) {
            const entryStr = JSON.stringify(entry, null, 2);
            console.log(`${COLORS.gray}${entryStr}${COLORS.reset}`);
        }
    } else {
        console.log(`${COLORS.green}OK${COLORS.reset}`);
    }
}

/**
 * Parse command line into tokens, handling quoted strings
 */
function parseCommandLine(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (inQuotes) {
            if (char === quoteChar) {
                inQuotes = false;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            inQuotes = true;
            quoteChar = char;
        } else if (char === ' ') {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Run the interactive CLI
 */
async function runCli(): Promise<void> {
    // Parse command line arguments for initial servers
    const args = process.argv.slice(2);
    const servers: ServerInfo[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--server' && args[i + 1]) {
            const parts = args[i + 1].split(':');
            servers.push({
                id: parts[0],
                address: parts[0],
                port: parts[1] ? parseInt(parts[1], 10) : 3000,
            });
            i++;
        }
    }

    // Use default servers if none specified
    const initialServers = servers.length > 0 ? servers : DEFAULT_SERVERS;

    let debug = args.includes('--debug');
    const client = new RaftClient(initialServers, debug);

    console.log(`
${COLORS.cyan}╔═══════════════════════════════════════════╗
║   Raft Key-Value Store Client             ║
╚═══════════════════════════════════════════╝${COLORS.reset}

Type ${COLORS.green}help${COLORS.reset} for available commands.
`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${COLORS.cyan}raft>${COLORS.reset} `,
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            rl.prompt();
            return;
        }

        const tokens = parseCommandLine(trimmed);
        const command = tokens[0].toLowerCase();
        const args = tokens.slice(1);

        try {
            switch (command) {
                case 'help':
                    printHelp();
                    break;

                case 'exit':
                case 'quit':
                    console.log('Goodbye!');
                    rl.close();
                    process.exit(0);
                    break;

                case 'debug':
                    debug = !debug;
                    console.log(`Debug mode: ${debug ? 'ON' : 'OFF'}`);
                    break;

                case 'connect': {
                    if (args.length < 1) {
                        console.log(`${COLORS.red}Usage: connect <address:port>${COLORS.reset}`);
                        break;
                    }
                    const parts = args[0].split(':');
                    const server: ServerInfo = {
                        id: parts[0],
                        address: parts[0],
                        port: parts[1] ? parseInt(parts[1], 10) : 3000,
                    };
                    client.addKnownServer(server);
                    console.log(`Added server ${server.id} (${server.address}:${server.port})`);
                    break;
                }

                case 'ping':
                case 'get':
                case 'set':
                case 'strln':
                case 'del':
                case 'append': {
                    const response = await client.execute(command, args);
                    printResponse(response);
                    break;
                }

                case 'request_log': {
                    const response = await client.requestLog();
                    printResponse(response);
                    break;
                }

                case 'add_server': {
                    if (args.length < 3) {
                        console.log(`${COLORS.red}Usage: add_server <id> <address> <port>${COLORS.reset}`);
                        break;
                    }
                    const response = await client.addServer(args[0], args[1], parseInt(args[2], 10));
                    printResponse(response);
                    break;
                }

                case 'remove_server': {
                    if (args.length < 1) {
                        console.log(`${COLORS.red}Usage: remove_server <id>${COLORS.reset}`);
                        break;
                    }
                    const response = await client.removeServer(args[0]);
                    printResponse(response);
                    break;
                }

                default:
                    console.log(`${COLORS.red}Unknown command: ${command}${COLORS.reset}`);
                    console.log(`Type ${COLORS.green}help${COLORS.reset} for available commands.`);
            }
        } catch (error) {
            console.log(`${COLORS.red}Error: ${(error as Error).message}${COLORS.reset}`);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        process.exit(0);
    });
}

// ============================================================================
// Entry Point
// ============================================================================

// Run CLI if this is the main module
if (require.main === module) {
    runCli().catch(console.error);
}

export { runCli };
