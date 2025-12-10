/**
 * Raft Core Types Module
 * 
 * This module defines the core data structures for the Raft consensus algorithm,
 * including node states, log entries, and the overall Raft state machine.
 * 
 * These types are shared across all team members:
 * - Person 1: Uses these for RPC and membership
 * - Person 2: Uses these for election and heartbeat logic
 * - Person 3: Uses these for log replication and KV store
 * 
 * @module raft/types
 */

import { ServerInfo } from '../config';

// ============================================================================
// Node State
// ============================================================================

/**
 * Raft node states
 * 
 * State transitions:
 * - FOLLOWER -> CANDIDATE: Election timeout expires
 * - CANDIDATE -> LEADER: Receives votes from majority
 * - CANDIDATE -> FOLLOWER: Discovers current leader or new term
 * - LEADER -> FOLLOWER: Discovers server with higher term
 */
export enum NodeState {
    FOLLOWER = 'FOLLOWER',
    CANDIDATE = 'CANDIDATE',
    LEADER = 'LEADER',
}

// ============================================================================
// Log Entry Types
// ============================================================================

/**
 * Types of log entries
 * - 'command': Normal key-value operations
 * - 'config': Cluster configuration changes (membership)
 * - 'noop': No-operation entry (used by new leader)
 */
export type LogEntryType = 'command' | 'config' | 'noop';

/**
 * Command types for key-value operations
 */
export type CommandType = 'set' | 'del' | 'append';

/**
 * A command to be stored in the log and applied to the state machine
 */
export interface Command {
    /** Type of command */
    type: CommandType;
    /** Key to operate on */
    key: string;
    /** Value for the operation (for set and append) */
    value?: string;
}

/**
 * Configuration change command for membership changes
 */
export interface ConfigChange {
    /** Type of configuration change */
    type: 'add_server' | 'remove_server';
    /** Server being added or removed */
    server: ServerInfo;
}

/**
 * A single entry in the Raft log
 * 
 * Log entries are replicated from the leader to all followers.
 * Once committed (replicated to majority), they are applied to the state machine.
 */
export interface LogEntry {
    /** Term when entry was received by leader */
    term: number;
    /** Position in the log (1-indexed, 0 means empty log) */
    index: number;
    /** Type of log entry */
    entryType: LogEntryType;
    /** Command to apply to state machine (for 'command' type) */
    command?: Command;
    /** Configuration change (for 'config' type) */
    configChange?: ConfigChange;
    /** Timestamp when entry was created */
    timestamp: number;
}

// ============================================================================
// Raft Persistent State (must survive restarts)
// ============================================================================

/**
 * Persistent state on all servers
 * (Updated on stable storage before responding to RPCs)
 */
export interface PersistentState {
    /** Latest term server has seen (starts at 0) */
    currentTerm: number;
    /** CandidateId that received vote in current term (null if none) */
    votedFor: string | null;
    /** Log entries (first index is 1) */
    log: LogEntry[];
}

// ============================================================================
// Raft Volatile State
// ============================================================================

/**
 * Volatile state on all servers
 * (Reinitialized after restart)
 */
export interface VolatileState {
    /** Index of highest log entry known to be committed */
    commitIndex: number;
    /** Index of highest log entry applied to state machine */
    lastApplied: number;
}

/**
 * Volatile state on leaders only
 * (Reinitialized after election)
 */
export interface LeaderState {
    /** 
     * For each server, index of next log entry to send to that server
     * (initialized to leader's last log index + 1)
     */
    nextIndex: Map<string, number>;
    /**
     * For each server, index of highest log entry known to be replicated
     * (initialized to 0)
     */
    matchIndex: Map<string, number>;
}

// ============================================================================
// Complete Raft State
// ============================================================================

/**
 * Complete state for a Raft node
 */
export interface RaftState {
    /** Current role of this node */
    nodeState: NodeState;
    /** Persistent state that must survive restarts */
    persistent: PersistentState;
    /** Volatile state on all servers */
    volatile: VolatileState;
    /** Volatile state only on leaders (null if not leader) */
    leaderState: LeaderState | null;
    /** Current leader ID (null if unknown) */
    leaderId: string | null;
    /** Current cluster configuration */
    clusterConfig: ServerInfo[];
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an initial empty log entry (index 0, used as sentinel)
 * This simplifies log index calculations.
 */
export function createEmptyLogEntry(): LogEntry {
    return {
        term: 0,
        index: 0,
        entryType: 'noop',
        timestamp: Date.now(),
    };
}

/**
 * Create an initial Raft state for a new node
 * 
 * @param clusterConfig - Initial cluster configuration
 * @returns Initial RaftState
 */
export function createInitialRaftState(clusterConfig: ServerInfo[]): RaftState {
    return {
        nodeState: NodeState.FOLLOWER,
        persistent: {
            currentTerm: 0,
            votedFor: null,
            // Start with empty sentinel entry at index 0
            log: [createEmptyLogEntry()],
        },
        volatile: {
            commitIndex: 0,
            lastApplied: 0,
        },
        leaderState: null,
        leaderId: null,
        clusterConfig: [...clusterConfig],
    };
}

/**
 * Initialize leader volatile state after winning election
 * 
 * @param lastLogIndex - Leader's last log index
 * @param clusterConfig - Current cluster configuration
 * @returns LeaderState object
 */
export function createLeaderState(
    lastLogIndex: number,
    clusterConfig: ServerInfo[]
): LeaderState {
    const nextIndex = new Map<string, number>();
    const matchIndex = new Map<string, number>();

    for (const server of clusterConfig) {
        // Initialize nextIndex to leader's last log index + 1
        nextIndex.set(server.id, lastLogIndex + 1);
        // Initialize matchIndex to 0
        matchIndex.set(server.id, 0);
    }

    return { nextIndex, matchIndex };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the last log entry
 * 
 * @param log - The log array
 * @returns Last log entry (never undefined due to sentinel)
 */
export function getLastLogEntry(log: LogEntry[]): LogEntry {
    return log[log.length - 1];
}

/**
 * Get the last log index
 * 
 * @param log - The log array
 * @returns Last log index (0 if only sentinel entry)
 */
export function getLastLogIndex(log: LogEntry[]): number {
    return log.length - 1;
}

/**
 * Get the last log term
 * 
 * @param log - The log array
 * @returns Term of the last log entry
 */
export function getLastLogTerm(log: LogEntry[]): number {
    return log[log.length - 1].term;
}

/**
 * Check if a candidate's log is at least as up-to-date as the voter's log
 * (Used in RequestVote RPC)
 * 
 * @param voterLastIndex - Voter's last log index
 * @param voterLastTerm - Voter's last log term
 * @param candidateLastIndex - Candidate's last log index
 * @param candidateLastTerm - Candidate's last log term
 * @returns True if candidate's log is at least as up-to-date
 */
export function isLogUpToDate(
    voterLastIndex: number,
    voterLastTerm: number,
    candidateLastIndex: number,
    candidateLastTerm: number
): boolean {
    // Candidate's log is up-to-date if:
    // 1. Candidate's last term is greater, OR
    // 2. Terms are equal and candidate's log is at least as long
    if (candidateLastTerm !== voterLastTerm) {
        return candidateLastTerm > voterLastTerm;
    }
    return candidateLastIndex >= voterLastIndex;
}
