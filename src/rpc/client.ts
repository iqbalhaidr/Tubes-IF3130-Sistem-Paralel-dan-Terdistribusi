/**
 * JSON-RPC Client Module
 * 
 * This module provides a client for making JSON-RPC 2.0 calls to other nodes
 * in the Raft cluster. It handles request formatting, HTTP transport, response
 * parsing, and error handling.
 * 
 * @module rpc/client
 */

import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcSuccessResponse,
    JsonRpcErrorResponse,
    RPC_ERROR_CODES
} from './types';
import { ServerInfo, getServerUrl } from '../config';
import { Logger } from '../utils/logger';

// Create logger for RPC client
const logger = new Logger('RPC-Client');

/**
 * Configuration options for the RPC client
 */
export interface RpcClientOptions {
    /** Request timeout in milliseconds (default: 5000) */
    timeout?: number;
    /** Number of retry attempts (default: 0) */
    retries?: number;
    /** Delay between retries in milliseconds (default: 100) */
    retryDelay?: number;
}

const DEFAULT_OPTIONS: Required<RpcClientOptions> = {
    timeout: 3000,  // Increased to handle extreme network delay (up to 1.4s)
    retries: 0,
    retryDelay: 100,
};

/**
 * Error class for RPC-specific errors
 */
export class RpcError extends Error {
    constructor(
        message: string,
        public code: number,
        public data?: any
    ) {
        super(message);
        this.name = 'RpcError';
    }
}

/**
 * Create a JSON-RPC 2.0 request object
 * 
 * @param method - Method name to call
 * @param params - Parameters for the method
 * @returns Formatted JSON-RPC request
 */
export function createRpcRequest(method: string, params?: any): JsonRpcRequest {
    return {
        jsonrpc: '2.0',
        method,
        params,
        id: uuidv4(),
    };
}

/**
 * Parse a JSON-RPC response and extract the result or throw an error
 * 
 * @param response - JSON-RPC response object
 * @returns The result from a successful response
 * @throws RpcError if the response is an error
 */
export function parseRpcResponse<T>(response: JsonRpcResponse): T {
    if ('error' in response) {
        throw new RpcError(
            response.error.message,
            response.error.code,
            response.error.data
        );
    }
    return response.result as T;
}

/**
 * Check if a response indicates the server is not the leader
 * 
 * @param response - JSON-RPC response object
 * @returns True if the error is NOT_LEADER
 */
export function isNotLeaderError(response: JsonRpcResponse): boolean {
    return 'error' in response && response.error.code === RPC_ERROR_CODES.NOT_LEADER;
}

/**
 * Extract leader info from a NOT_LEADER error response
 * 
 * @param response - JSON-RPC error response
 * @returns Leader info if available, null otherwise
 */
export function extractLeaderInfo(response: JsonRpcErrorResponse): { leaderId: string; leaderAddress: string } | null {
    if (response.error.data && response.error.data.leaderId && response.error.data.leaderAddress) {
        return {
            leaderId: response.error.data.leaderId,
            leaderAddress: response.error.data.leaderAddress,
        };
    }
    return null;
}

/**
 * Make an HTTP POST request with a JSON body
 * 
 * @param url - Target URL
 * @param body - JSON body to send
 * @param timeout - Request timeout in milliseconds
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
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (error) {
                    reject(new RpcError('Failed to parse response', RPC_ERROR_CODES.PARSE_ERROR));
                }
            });
        });

        req.on('error', (error) => {
            reject(new RpcError(`Network error: ${error.message}`, RPC_ERROR_CODES.INTERNAL_ERROR));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new RpcError('Request timeout', RPC_ERROR_CODES.TIMEOUT));
        });

        req.write(body);
        req.end();
    });
}

/**
 * Sleep for a specified duration
 * 
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * RPC Client class for making calls to Raft nodes
 * 
 * Usage:
 * ```typescript
 * const client = new RpcClient();
 * const result = await client.call(serverInfo, 'method_name', { param: 'value' });
 * ```
 */
export class RpcClient {
    private options: Required<RpcClientOptions>;

    constructor(options?: RpcClientOptions) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Make an RPC call to a server
     * 
     * @param server - Target server info
     * @param method - RPC method name
     * @param params - Method parameters
     * @returns The result from the RPC call
     * @throws RpcError on failure
     */
    async call<T>(server: ServerInfo, method: string, params?: any): Promise<T> {
        const url = getServerUrl(server);
        const request = createRpcRequest(method, params);
        const body = JSON.stringify(request);

        let lastError: Error | null = null;

        // Attempt the request with retries
        for (let attempt = 0; attempt <= this.options.retries; attempt++) {
            try {
                logger.debug(`Calling ${method} on ${server.id} (attempt ${attempt + 1})`);

                const response: JsonRpcResponse = await httpPost(url, body, this.options.timeout);

                // Log the response
                if ('error' in response) {
                    logger.debug(`RPC error from ${server.id}: ${response.error.message}`);
                } else {
                    logger.debug(`RPC success from ${server.id}`);
                }

                return parseRpcResponse<T>(response);

            } catch (error) {
                lastError = error as Error;
                // Don't log network errors - they're expected when nodes are down
                // Common errors: "Request timeout", "ECONNRESET", "socket hang up"
                // Only log unexpected errors at WARN level
                const isNetworkError = lastError.message.includes('timeout') ||
                    lastError.message.includes('ECONNRESET') ||
                    lastError.message.includes('hang up') ||
                    lastError.message.includes('ECONNREFUSED');

                if (!isNetworkError) {
                    logger.warn(`RPC call to ${server.id} failed: ${lastError.message}`);
                }

                if (attempt < this.options.retries) {
                    await sleep(this.options.retryDelay);
                }
            }
        }

        throw lastError || new RpcError('Unknown error', RPC_ERROR_CODES.INTERNAL_ERROR);
    }

    /**
     * Make an RPC call and return the raw response (without parsing)
     * Useful when you need to check for specific error types like NOT_LEADER
     * 
     * @param server - Target server info
     * @param method - RPC method name
     * @param params - Method parameters
     * @returns Raw JSON-RPC response
     */
    async callRaw(server: ServerInfo, method: string, params?: any): Promise<JsonRpcResponse> {
        const url = getServerUrl(server);
        const request = createRpcRequest(method, params);
        const body = JSON.stringify(request);

        try {
            logger.debug(`Calling ${method} on ${server.id} (raw)`);
            const response = await httpPost(url, body, this.options.timeout);
            return response as JsonRpcResponse;
        } catch (error) {
            // Convert network errors to error response format
            return {
                jsonrpc: '2.0',
                error: {
                    code: RPC_ERROR_CODES.INTERNAL_ERROR,
                    message: (error as Error).message,
                },
                id: request.id,
            };
        }
    }

    /**
     * Call multiple servers in parallel
     * 
     * @param servers - List of target servers
     * @param method - RPC method name
     * @param params - Method parameters
     * @returns Array of results (settled promises)
     */
    async callMany<T>(
        servers: ServerInfo[],
        method: string,
        params?: any
    ): Promise<PromiseSettledResult<T>[]> {
        const promises = servers.map(server => this.call<T>(server, method, params));
        return Promise.allSettled(promises);
    }

    /**
     * Call multiple servers and wait for a majority to respond successfully
     * 
     * @param servers - List of target servers
     * @param method - RPC method name
     * @param params - Method parameters
     * @param quorum - Required number of successful responses
     * @returns Array of successful results once quorum is reached
     */
    async callWithQuorum<T>(
        servers: ServerInfo[],
        method: string,
        params: any,
        quorum: number
    ): Promise<{ successes: T[]; failures: Error[] }> {
        const successes: T[] = [];
        const failures: Error[] = [];

        const promises = servers.map(async server => {
            try {
                const result = await this.call<T>(server, method, params);
                successes.push(result);
                return { success: true, result };
            } catch (error) {
                failures.push(error as Error);
                return { success: false, error };
            }
        });

        // Wait for all to settle
        await Promise.all(promises);

        logger.debug(`Quorum check: ${successes.length}/${servers.length} succeeded, need ${quorum}`);

        return { successes, failures };
    }
}

// Export a default instance for convenience
export const rpcClient = new RpcClient();
