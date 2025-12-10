/**
 * RPC System Unit Tests
 * 
 * Tests for JSON-RPC server, client, and message formatting.
 */

import {
    createRpcRequest,
    parseRpcResponse,
    RpcError,
    isNotLeaderError,
    extractLeaderInfo
} from '../src/rpc/client';
import {
    createSuccessResponse,
    createErrorResponse,
    createNotLeaderResponse,
    RpcServer,
    rpcError
} from '../src/rpc/server';
import { RPC_ERROR_CODES, JsonRpcResponse } from '../src/rpc/types';

describe('RPC Client', () => {
    describe('createRpcRequest', () => {
        it('should create a valid JSON-RPC 2.0 request', () => {
            const request = createRpcRequest('test_method', { key: 'value' });

            expect(request.jsonrpc).toBe('2.0');
            expect(request.method).toBe('test_method');
            expect(request.params).toEqual({ key: 'value' });
            expect(request.id).toBeDefined();
            expect(typeof request.id).toBe('string');
        });

        it('should create request without params', () => {
            const request = createRpcRequest('no_params');

            expect(request.jsonrpc).toBe('2.0');
            expect(request.method).toBe('no_params');
            expect(request.params).toBeUndefined();
        });

        it('should generate unique IDs', () => {
            const request1 = createRpcRequest('method');
            const request2 = createRpcRequest('method');

            expect(request1.id).not.toBe(request2.id);
        });
    });

    describe('parseRpcResponse', () => {
        it('should parse success response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                result: { data: 'test' },
                id: '123',
            };

            const result = parseRpcResponse<{ data: string }>(response);
            expect(result).toEqual({ data: 'test' });
        });

        it('should throw RpcError for error response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: {
                    code: -32600,
                    message: 'Invalid Request',
                },
                id: '123',
            };

            expect(() => parseRpcResponse(response)).toThrow(RpcError);

            try {
                parseRpcResponse(response);
            } catch (error) {
                expect(error).toBeInstanceOf(RpcError);
                expect((error as RpcError).code).toBe(-32600);
                expect((error as RpcError).message).toBe('Invalid Request');
            }
        });
    });

    describe('isNotLeaderError', () => {
        it('should return true for NOT_LEADER error', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: {
                    code: RPC_ERROR_CODES.NOT_LEADER,
                    message: 'Not the leader',
                    data: { leaderId: 'node2', leaderAddress: 'node2:3000' },
                },
                id: '123',
            };

            expect(isNotLeaderError(response)).toBe(true);
        });

        it('should return false for other errors', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: {
                    code: RPC_ERROR_CODES.INTERNAL_ERROR,
                    message: 'Internal error',
                },
                id: '123',
            };

            expect(isNotLeaderError(response)).toBe(false);
        });

        it('should return false for success response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                result: {},
                id: '123',
            };

            expect(isNotLeaderError(response)).toBe(false);
        });
    });

    describe('extractLeaderInfo', () => {
        it('should extract leader info from error data', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: {
                    code: RPC_ERROR_CODES.NOT_LEADER,
                    message: 'Not the leader',
                    data: { leaderId: 'node2', leaderAddress: 'node2:3000' },
                },
                id: '123',
            };

            const info = extractLeaderInfo(response as any);
            expect(info).toEqual({ leaderId: 'node2', leaderAddress: 'node2:3000' });
        });

        it('should return null if leader info is missing', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: {
                    code: RPC_ERROR_CODES.NOT_LEADER,
                    message: 'Not the leader',
                },
                id: '123',
            };

            const info = extractLeaderInfo(response as any);
            expect(info).toBeNull();
        });
    });
});

describe('RPC Server', () => {
    describe('createSuccessResponse', () => {
        it('should create a valid success response', () => {
            const response = createSuccessResponse('123', { key: 'value' });

            expect(response.jsonrpc).toBe('2.0');
            expect(response.result).toEqual({ key: 'value' });
            expect(response.id).toBe('123');
            expect('error' in response).toBe(false);
        });
    });

    describe('createErrorResponse', () => {
        it('should create a valid error response', () => {
            const response = createErrorResponse('123', {
                code: -32600,
                message: 'Invalid Request',
            });

            expect(response.jsonrpc).toBe('2.0');
            expect(response.error.code).toBe(-32600);
            expect(response.error.message).toBe('Invalid Request');
            expect(response.id).toBe('123');
        });

        it('should handle null id', () => {
            const response = createErrorResponse(null, {
                code: -32700,
                message: 'Parse error',
            });

            expect(response.id).toBeNull();
        });
    });

    describe('createNotLeaderResponse', () => {
        it('should create NOT_LEADER error with leader info', () => {
            const response = createNotLeaderResponse('123', 'node2', 'node2:3000');

            expect(response.error.code).toBe(RPC_ERROR_CODES.NOT_LEADER);
            expect(response.error.message).toBe('Not the leader');
            expect(response.error.data).toEqual({
                leaderId: 'node2',
                leaderAddress: 'node2:3000',
            });
        });
    });

    describe('rpcError', () => {
        it('should create an error with code and data', () => {
            const error = rpcError(-32000, 'Custom error', { detail: 'info' });

            expect(error.message).toBe('Custom error');
            expect((error as any).code).toBe(-32000);
            expect((error as any).data).toEqual({ detail: 'info' });
        });
    });

    describe('RpcServer', () => {
        let server: RpcServer;

        beforeEach(() => {
            server = new RpcServer(0); // Port 0 = random available port
        });

        afterEach(async () => {
            await server.stop();
        });

        it('should register handlers', () => {
            const handler = jest.fn().mockResolvedValue({ success: true });

            server.registerHandler('test_method', handler);

            // Handler should be registered (we can't easily test internal state,
            // but we can test that registering doesn't throw)
            expect(() => server.registerHandler('another', handler)).not.toThrow();
        });

        it('should register multiple handlers', () => {
            const handlers = {
                method1: jest.fn().mockResolvedValue(1),
                method2: jest.fn().mockResolvedValue(2),
            };

            expect(() => server.registerHandlers(handlers)).not.toThrow();
        });
    });
});

describe('RPC Error Codes', () => {
    it('should have correct standard error codes', () => {
        expect(RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
        expect(RPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
        expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
        expect(RPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
        expect(RPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
    });

    it('should have custom error codes in valid range', () => {
        expect(RPC_ERROR_CODES.NOT_LEADER).toBeGreaterThanOrEqual(-32099);
        expect(RPC_ERROR_CODES.NOT_LEADER).toBeLessThanOrEqual(-32000);
        expect(RPC_ERROR_CODES.TIMEOUT).toBeGreaterThanOrEqual(-32099);
        expect(RPC_ERROR_CODES.TIMEOUT).toBeLessThanOrEqual(-32000);
    });
});
