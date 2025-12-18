/**
 * JSON-RPC Server Module, provides an HTTP-based JSON-RPC 2.0 server for handling
 * incoming RPC requests from other nodes and clients.
 * 
 * @module rpc/server
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcSuccessResponse,
    JsonRpcErrorResponse,
    JsonRpcError,
    RPC_ERROR_CODES,
    RpcMethodName
} from './types';
import { Logger } from '../utils/logger';

// Create logger for RPC server
const logger = new Logger('RPC-Server');

/**
 * Type for RPC method handlers
 * Handlers receive params and return a result or throw an error
 */
export type RpcHandler = (params: any) => Promise<any>;

/**
 * Registry of RPC method handlers
 */
type HandlerRegistry = Map<string, RpcHandler>;

/**
 * Create a JSON-RPC success response
 * 
 * @param id - Request ID
 * @param result - Result data
 * @returns Formatted success response
 */
export function createSuccessResponse(id: string | number, result: any): JsonRpcSuccessResponse {
    return {
        jsonrpc: '2.0',
        result,
        id,
    };
}

/**
 * Create a JSON-RPC error response
 * 
 * @param id - Request ID (null if unknown)
 * @param error - Error object
 * @returns Formatted error response
 */
export function createErrorResponse(
    id: string | number | null,
    error: JsonRpcError
): JsonRpcErrorResponse {
    return {
        jsonrpc: '2.0',
        error,
        id,
    };
}

/**
 * Create a "not leader" error response with leader info
 * 
 * @param id - Request ID
 * @param leaderId - Current leader ID
 * @param leaderAddress - Current leader address
 * @returns Not leader error response
 */
export function createNotLeaderResponse(
    id: string | number,
    leaderId: string | null,
    leaderAddress: string | null
): JsonRpcErrorResponse {
    return createErrorResponse(id, {
        code: RPC_ERROR_CODES.NOT_LEADER,
        message: 'Not the leader',
        data: { leaderId, leaderAddress },
    });
}

/**
 * Validate a JSON-RPC request object
 * 
 * @param body - Request body to validate
 * @returns Validation result with parsed request or error
 */
function validateRequest(body: any): { valid: true; request: JsonRpcRequest } | { valid: false; error: JsonRpcError } {
    // Check if body is an object
    if (!body || typeof body !== 'object') {
        return {
            valid: false,
            error: {
                code: RPC_ERROR_CODES.INVALID_REQUEST,
                message: 'Invalid Request: body must be an object',
            },
        };
    }

    // Check jsonrpc version
    if (body.jsonrpc !== '2.0') {
        return {
            valid: false,
            error: {
                code: RPC_ERROR_CODES.INVALID_REQUEST,
                message: 'Invalid Request: jsonrpc must be "2.0"',
            },
        };
    }

    // Check method
    if (typeof body.method !== 'string' || body.method.length === 0) {
        return {
            valid: false,
            error: {
                code: RPC_ERROR_CODES.INVALID_REQUEST,
                message: 'Invalid Request: method must be a non-empty string',
            },
        };
    }

    // Check id (string or number)
    if (body.id === undefined || body.id === null) {
        return {
            valid: false,
            error: {
                code: RPC_ERROR_CODES.INVALID_REQUEST,
                message: 'Invalid Request: id is required',
            },
        };
    }

    if (typeof body.id !== 'string' && typeof body.id !== 'number') {
        return {
            valid: false,
            error: {
                code: RPC_ERROR_CODES.INVALID_REQUEST,
                message: 'Invalid Request: id must be a string or number',
            },
        };
    }

    return {
        valid: true,
        request: body as JsonRpcRequest,
    };
}

/**
 * RPC Server class for handling JSON-RPC requests
 */
export class RpcServer {
    private app: Express;
    private port: number;
    private handlers: HandlerRegistry = new Map();
    private server: any = null;

    /**
     * Create a new RPC server
     * 
     * @param port - Port to listen on
     */
    constructor(port: number) {
        this.port = port;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Set up Express middleware
     */
    private setupMiddleware(): void {
        // Parse JSON bodies
        this.app.use(express.json());

        // Request logging middleware
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            logger.debug(`Received ${req.method} ${req.path}`);
            next();
        });

        // Error handling for JSON parse errors
        this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
            if (err instanceof SyntaxError) {
                const response = createErrorResponse(null, {
                    code: RPC_ERROR_CODES.PARSE_ERROR,
                    message: 'Parse error: Invalid JSON',
                });
                res.status(200).json(response);
                return;
            }
            next(err);
        });
    }

    /**
     * Set up RPC routes
     */
    private setupRoutes(): void {
        // Main RPC endpoint
        this.app.post('/rpc', async (req: Request, res: Response) => {
            const response = await this.handleRequest(req.body);
            res.json(response);
        });

        // Health check endpoint
        this.app.get('/health', (req: Request, res: Response) => {
            res.json({ status: 'ok', timestamp: Date.now() });
        });
    }

    /**
     * Handle a JSON-RPC request
     * 
     * @param body - Request body
     * @returns JSON-RPC response
     */
    private async handleRequest(body: any): Promise<JsonRpcResponse> {
        // Validate the request
        const validation = validateRequest(body);

        if (!validation.valid) {
            return createErrorResponse(null, validation.error);
        }

        const request = validation.request;

        // Log the incoming RPC
        logger.rpc('IN', request.method, 'client', `id=${request.id}`);

        // Find the handler
        const handler = this.handlers.get(request.method);

        if (!handler) {
            logger.warn(`Method not found: ${request.method}`);
            return createErrorResponse(request.id, {
                code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                message: `Method not found: ${request.method}`,
            });
        }

        // Execute the handler
        try {
            const result = await handler(request.params);
            logger.debug(`Method ${request.method} completed successfully`);
            return createSuccessResponse(request.id, result);
        } catch (error) {
            const err = error as Error;
            logger.error(`Method ${request.method} failed:`, err.message);

            // Check if RPC error with a code
            if ('code' in err && typeof (err as any).code === 'number') {
                return createErrorResponse(request.id, {
                    code: (err as any).code,
                    message: err.message,
                    data: (err as any).data,
                });
            }

            return createErrorResponse(request.id, {
                code: RPC_ERROR_CODES.INTERNAL_ERROR,
                message: err.message || 'Internal error',
            });
        }
    }

    /**
     * Register an RPC method handler
     * 
     * @param method - Method name
     * @param handler - Handler function
     */
    registerHandler(method: string, handler: RpcHandler): void {
        logger.info(`Registered handler for method: ${method}`);
        this.handlers.set(method, handler);
    }

    /**
     * Register multiple handlers at once
     * 
     * @param handlers - Map of method names to handlers
     */
    registerHandlers(handlers: Record<string, RpcHandler>): void {
        for (const [method, handler] of Object.entries(handlers)) {
            this.registerHandler(method, handler);
        }
    }

    /**
     * Start the RPC server
     * 
     * @returns Promise that resolves when server is listening
     */
    start(): Promise<void> {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                logger.info(`RPC Server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the RPC server
     * 
     * @returns Promise that resolves when server is closed
     */
    stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }

            this.server.close((err: Error | undefined) => {
                if (err) {
                    reject(err);
                } else {
                    logger.info('RPC Server stopped');
                    resolve();
                }
            });
        });
    }

    /**
     * Get the Express app instance (for testing purposes)
     */
    getApp(): Express {
        return this.app;
    }
}

/**
 * Create an RPC error that can be thrown in handlers
 * The error will be properly formatted in the response
 * 
 * @param code - Error code
 * @param message - Error message
 * @param data - Additional data
 */
export function rpcError(code: number, message: string, data?: any): Error {
    const error = new Error(message) as any;
    error.code = code;
    error.data = data;
    return error;
}

/**
 * Create a "not leader" error that can be thrown in handlers
 * 
 * @param leaderId - Current leader ID
 * @param leaderAddress - Current leader address
 */
export function notLeaderError(leaderId: string | null, leaderAddress: string | null): Error {
    return rpcError(RPC_ERROR_CODES.NOT_LEADER, 'Not the leader', { leaderId, leaderAddress });
}
