/**
 * Raft Core Types Module -> defines the core data structures for the Raft consensus algorithm,
 * including node states, log entries, and the overall Raft state machine.
 * @module raft/types
 */

import { ServerInfo } from '../config';

// ============================================================================
// Node State
// ============================================================================

/**
 * Raft node states
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
    type: CommandType;
    key: string;
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
 */
export interface LogEntry {
    term: number;
    index: number;
    entryType: LogEntryType;
    command?: Command;
    configChange?: ConfigChange;
    timestamp: number;
}

// ============================================================================
// Raft Persistent State (must survive restarts)
// ============================================================================

/**
 * Persistent state on all servers
 */
export interface PersistentState {
    currentTerm: number;
    votedFor: string | null;
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
    commitIndex: number;
    lastApplied: number;
}

/**
 * Volatile state on leaders only
 * (Reinitialized after election)
 */
export interface LeaderState {
    nextIndex: Map<string, number>;
    matchIndex: Map<string, number>;
}

// ============================================================================
// Complete Raft State
// ============================================================================

/**
 * Complete state for a Raft node
 */
export interface RaftState {
    nodeState: NodeState;
    persistent: PersistentState;
    volatile: VolatileState;
    leaderState: LeaderState | null;
    leaderId: string | null;
    clusterConfig: ServerInfo[];
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an initial empty log entry (index 0, used as sentinel)
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
        nextIndex.set(server.id, lastLogIndex + 1);
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
    // Candidate's log is up-to-date if candidate last term > voter last term, or
    // Terms are equal and candidates log >= voters log
    if (candidateLastTerm !== voterLastTerm) {
        return candidateLastTerm > voterLastTerm;
    }
    return candidateLastIndex >= voterLastIndex;
}
