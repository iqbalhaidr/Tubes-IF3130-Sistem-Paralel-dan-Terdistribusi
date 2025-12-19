/**
 * RPC Types Module, defines all JSON-RPC 2.0 message types and Raft-specific
 * RPC request/response structures for inter-node and client communication.
 * 
 * @module rpc/types
 */

import { ServerInfo } from '../config';
import { LogEntry } from '../raft/types';

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id: string | number;
}

/**
 * JSON-RPC 2.0 Success Response
 */
export interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    result: any;
    id: string | number;
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcError {
    code: number;
    message: string;
    data?: any;
}

/**
 * JSON-RPC 2.0 Error Response
 */
export interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    error: JsonRpcError;
    id: string | number | null;
}

/** Union type for all JSON-RPC responses */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ============================================================================
// JSON-RPC 2.0 Standard Error Codes
// ============================================================================

export const RPC_ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    NOT_LEADER: -32000,
    TIMEOUT: -32001,
    NOT_READY: -32002,
} as const;

// ============================================================================
// Raft RPC Types - RequestVote
// ============================================================================

/**
 * RequestVote RPC request (from Candidate to all other nodes) for leader election.
 */
export interface RequestVoteRequest {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
}

/**
 * RequestVote RPC response
 */
export interface RequestVoteResponse {
    term: number;
    voteGranted: boolean;
}

// ============================================================================
// Raft RPC Types - AppendEntries 
// ============================================================================

/**
 * AppendEntries RPC request (from Leader to Followers) for log replication and as heartbeat when entries empty.
 */
export interface AppendEntriesRequest {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
}

/**
 * AppendEntries RPC response
 */
export interface AppendEntriesResponse {
    term: number;
    success: boolean;
    matchIndex?: number;
}

// ============================================================================
// Membership Change RPC Types
// ============================================================================

/**
 * AddServer RPC request -> Adds a new server to the cluster
 */
export interface AddServerRequest {
    newServer: ServerInfo;
}

/**
 * AddServer RPC response
 */
export interface AddServerResponse {
    success: boolean;
    leaderId: string | null;
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
    success: boolean;
    leaderId: string | null;
    error?: string;
}

// ============================================================================
// Client Interface RPC Types 
// ============================================================================

/** Valid client commands for the key-value store */
export type ClientCommand = 'ping' | 'get' | 'set' | 'strln' | 'del' | 'append';

/**
 * Execute RPC request -> Client request to execute a command
 */
export interface ExecuteRequest {
    command: ClientCommand;
    args: string[];
}

/**
 * Execute RPC response
 */
export interface ExecuteResponse {
    success: boolean;
    result: string;
    leaderId: string | null;
    leaderAddress?: string;
}

/**
 * RequestLog RPC request -> Get the leader's log
 */
export interface RequestLogRequest {
}

/**
 * RequestLog RPC response
 */
export interface RequestLogResponse {
    success: boolean;
    log: LogEntry[];
    leaderId: string | null;
    leaderAddress?: string;
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
