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
