/**
 * RPC Types Module
 * 
 * This module defines all JSON-RPC 2.0 message types and Raft-specific
 * RPC request/response structures for inter-node and client communication.
 * 
 * Based on JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
 * 
 * @module rpc/types
 */

import { ServerInfo } from '../config';
import { LogEntry } from '../raft/types';

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

/**
 * JSON-RPC 2.0 Request object
 */
export interface JsonRpcRequest {
    /** Must be exactly "2.0" per JSON-RPC spec */
    jsonrpc: '2.0';
    /** Name of the method to invoke */
    method: string;
    /** Parameters for the method (structured or positional) */
    params?: any;
    /** Request identifier for matching response */
    id: string | number;
}

/**
 * JSON-RPC 2.0 Success Response
 */
export interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    /** Result of the method invocation */
    result: any;
    /** Same ID as the request */
    id: string | number;
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcError {
    /** Error code (negative for pre-defined errors) */
    code: number;
    /** Short description of the error */
    message: string;
    /** Additional error data */
    data?: any;
}

/**
 * JSON-RPC 2.0 Error Response
 */
export interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    /** Error object with code and message */
    error: JsonRpcError;
    /** Same ID as the request, or null if ID couldn't be determined */
    id: string | number | null;
}

/** Union type for all JSON-RPC responses */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ============================================================================
// JSON-RPC 2.0 Standard Error Codes
// ============================================================================

export const RPC_ERROR_CODES = {
    /** Invalid JSON was received */
    PARSE_ERROR: -32700,
    /** The JSON sent is not a valid Request object */
    INVALID_REQUEST: -32600,
    /** The method does not exist or is not available */
    METHOD_NOT_FOUND: -32601,
    /** Invalid method parameter(s) */
    INVALID_PARAMS: -32602,
    /** Internal JSON-RPC error */
    INTERNAL_ERROR: -32603,

    // Custom error codes (must be in -32000 to -32099 range)
    /** Not the leader, request should be redirected */
    NOT_LEADER: -32000,
    /** Request timeout */
    TIMEOUT: -32001,
    /** Server is not ready (e.g., election in progress) */
    NOT_READY: -32002,
} as const;

// ============================================================================
// Raft RPC Types - RequestVote (Leader Election - Person 2)
// ============================================================================

/**
 * RequestVote RPC request (from Candidate to all other nodes)
 * Used during leader election to request votes from other nodes.
 */
export interface RequestVoteRequest {
    /** Candidate's term number */
    term: number;
    /** Candidate requesting the vote */
    candidateId: string;
    /** Index of candidate's last log entry */
    lastLogIndex: number;
    /** Term of candidate's last log entry */
    lastLogTerm: number;
}

/**
 * RequestVote RPC response
 */
export interface RequestVoteResponse {
    /** Current term, for candidate to update itself */
    term: number;
    /** True if candidate received vote */
    voteGranted: boolean;
}

// ============================================================================
// Raft RPC Types - AppendEntries (Log Replication - Person 3)
// ============================================================================

/**
 * AppendEntries RPC request (from Leader to Followers)
 * Used for log replication and as heartbeat when entries is empty.
 */
export interface AppendEntriesRequest {
    /** Leader's term */
    term: number;
    /** Leader's ID so followers can redirect clients */
    leaderId: string;
    /** Index of log entry immediately preceding new ones */
    prevLogIndex: number;
    /** Term of prevLogIndex entry */
    prevLogTerm: number;
    /** Log entries to store (empty for heartbeat) */
    entries: LogEntry[];
    /** Leader's commitIndex */
    leaderCommit: number;
}

/**
 * AppendEntries RPC response
 */
export interface AppendEntriesResponse {
    /** Current term, for leader to update itself */
    term: number;
    /** True if follower contained entry matching prevLogIndex and prevLogTerm */
    success: boolean;
    /** (Optional) The follower's last log index, for faster log catchup */
    matchIndex?: number;
}

// ============================================================================
// Membership Change RPC Types (Person 1)
// ============================================================================

/**
 * AddServer RPC request - Adds a new server to the cluster
 */
export interface AddServerRequest {
    /** Information about the new server to add */
    newServer: ServerInfo;
}

/**
 * AddServer RPC response
 */
export interface AddServerResponse {
    /** Whether the operation was successful */
    success: boolean;
    /** Current leader ID (for redirect if not leader) */
    leaderId: string | null;
    /** Error message if failed */
    error?: string;
}

/**
 * RemoveServer RPC request - Removes a server from the cluster
 */
export interface RemoveServerRequest {
    /** ID of the server to remove */
    serverId: string;
}

/**
 * RemoveServer RPC response
 */
export interface RemoveServerResponse {
    /** Whether the operation was successful */
    success: boolean;
    /** Current leader ID (for redirect if not leader) */
    leaderId: string | null;
    /** Error message if failed */
    error?: string;
}

// ============================================================================
// Client Interface RPC Types (Person 1)
// ============================================================================

/** Valid client commands for the key-value store */
export type ClientCommand = 'ping' | 'get' | 'set' | 'strln' | 'del' | 'append';

/**
 * Execute RPC request - Client request to execute a command
 */
export interface ExecuteRequest {
    /** Command to execute */
    command: ClientCommand;
    /** Arguments for the command */
    args: string[];
}

/**
 * Execute RPC response
 */
export interface ExecuteResponse {
    /** Whether the operation was successful */
    success: boolean;
    /** Result of the operation */
    result: string;
    /** Current leader ID (for redirect if not leader) */
    leaderId: string | null;
    /** Leader address for client redirect */
    leaderAddress?: string;
}

/**
 * RequestLog RPC request - Get the leader's log
 */
export interface RequestLogRequest {
    // Empty - no parameters needed
}

/**
 * RequestLog RPC response
 */
export interface RequestLogResponse {
    /** Whether the operation was successful */
    success: boolean;
    /** Log entries from the leader */
    log: LogEntry[];
    /** Current leader ID (for redirect if not leader) */
    leaderId: string | null;
    /** Leader address for client redirect */
    leaderAddress?: string;
    /** Error message if failed */
    error?: string;
}

// ============================================================================
// RPC Method Names
// ============================================================================

/**
 * All RPC method names used in the system
 */
export const RPC_METHODS = {
    // Raft internal RPCs
    REQUEST_VOTE: 'request_vote',
    APPEND_ENTRIES: 'append_entries',

    // Membership change RPCs
    ADD_SERVER: 'add_server',
    REMOVE_SERVER: 'remove_server',

    // Client interface RPCs
    EXECUTE: 'execute',
    REQUEST_LOG: 'request_log',
} as const;

export type RpcMethodName = typeof RPC_METHODS[keyof typeof RPC_METHODS];
