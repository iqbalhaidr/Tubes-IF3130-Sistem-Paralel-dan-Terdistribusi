/**
 * Raft Node Module
 * 
 * This module provides the base RaftNode class that implements the Raft consensus
 * protocol. It integrates components from all team members:
 * 
 * - Person 1: RPC system, membership changes
 * - Person 2: Leader election, heartbeat (TODO methods marked)
 * - Person 3: Log replication, state machine (TODO methods marked)
 * 
 * @module raft/node
 */

import { EventEmitter } from 'events';
import {
    RaftState,
    NodeState,
    LogEntry,
    createInitialRaftState,
    createLeaderState,
    getLastLogIndex,
    getLastLogTerm,
    Command,
    ConfigChange,
} from './types';
import { RaftConfig, ServerInfo, getServerUrl } from '../config';
import { RpcServer } from '../rpc/server';
import { RpcClient } from '../rpc/client';
import { createRpcHandlers, IRaftNode } from '../rpc/handlers';
import {
    RequestVoteRequest,
    RequestVoteResponse,
    AppendEntriesRequest,
    AppendEntriesResponse,
    AddServerRequest,
    AddServerResponse,
    RemoveServerRequest,
    RemoveServerResponse,
} from '../rpc/types';
import { KeyValueStore, executeKvCommand } from '../store/kv-store';
import { Logger } from '../utils/logger';

const logger = new Logger('RaftNode');

/**
 * Main Raft Node class
 * 
 * This class coordinates all Raft functionality and provides
 * interfaces for teammates to implement specific features.
 */
export class RaftNode extends EventEmitter implements IRaftNode {
    /** Node configuration */
    private config: RaftConfig;
    /** Raft state (persistent + volatile) */
    private state: RaftState;
    /** RPC server for incoming requests */
    private rpcServer: RpcServer;
    /** RPC client for outgoing requests */
    private rpcClient: RpcClient;
    /** Key-value store (state machine) */
    private kvStore: KeyValueStore;

    // Timers (Person 2 will manage these)
    private electionTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    constructor(config: RaftConfig) {
        super();
        this.config = config;
        this.state = createInitialRaftState(config.clusterNodes);
        this.rpcServer = new RpcServer(config.port);
        this.rpcClient = new RpcClient({ timeout: 3000, retries: 1 });
        this.kvStore = new KeyValueStore();

        // Set up logger context
        logger.setNodeId(config.nodeId);

        // Register RPC handlers
        const handlers = createRpcHandlers(this);
        this.rpcServer.registerHandlers(handlers);

        logger.info(`Initialized with ${config.clusterNodes.length} nodes in cluster`);
    }

    // ============================================================================
    // State Getters (IRaftNode interface)
    // ============================================================================

    getNodeId(): string {
        return this.config.nodeId;
    }

    getNodeState(): NodeState {
        return this.state.nodeState;
    }

    getCurrentTerm(): number {
        return this.state.persistent.currentTerm;
    }

    getLeaderId(): string | null {
        return this.state.leaderId;
    }

    getLeaderAddress(): string | null {
        if (!this.state.leaderId) return null;
        const leader = this.state.clusterConfig.find(s => s.id === this.state.leaderId);
        return leader ? `${leader.address}:${leader.port}` : null;
    }

    getLog(): LogEntry[] {
        return [...this.state.persistent.log];
    }

    // ============================================================================
    // Server Lifecycle
    // ============================================================================

    /**
     * Start the Raft node
     */
    async start(): Promise<void> {
        logger.info('Starting Raft node...');

        // Start RPC server
        await this.rpcServer.start();

        // Start as follower and begin election timer
        this.transitionTo(NodeState.FOLLOWER, 'initial start');
        this.resetElectionTimer();

        logger.info('Raft node started');
    }

    /**
     * Stop the Raft node
     */
    async stop(): Promise<void> {
        logger.info('Stopping Raft node...');

        // Clear timers
        if (this.electionTimer) {
            clearTimeout(this.electionTimer);
            this.electionTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Stop RPC server
        await this.rpcServer.stop();

        logger.info('Raft node stopped');
    }

    // ============================================================================
    // State Transitions
    // ============================================================================

    /**
     * Transition to a new state
     * 
     * @param newState - Target state
     * @param reason - Reason for transition (for logging)
     */
    private transitionTo(newState: NodeState, reason: string): void {
        const oldState = this.state.nodeState;
        if (oldState === newState) return;

        logger.stateChange(oldState, newState, reason);
        this.state.nodeState = newState;

        // Clean up old state
        if (oldState === NodeState.LEADER) {
            this.stopHeartbeat();
            this.state.leaderState = null;
        }

        // Initialize new state
        if (newState === NodeState.LEADER) {
            this.state.leaderId = this.config.nodeId;
            this.state.leaderState = createLeaderState(
                getLastLogIndex(this.state.persistent.log),
                this.state.clusterConfig
            );
            this.startHeartbeat();
        } else if (newState === NodeState.FOLLOWER) {
            this.resetElectionTimer();
        }

        this.emit('stateChange', oldState, newState);
    }

    /**
     * Update term if we discover a higher term
     * 
     * @param term - Discovered term
     * @returns True if term was updated
     */
    private updateTerm(term: number): boolean {
        if (term > this.state.persistent.currentTerm) {
            logger.info(`Discovered higher term ${term}, updating from ${this.state.persistent.currentTerm}`);
            this.state.persistent.currentTerm = term;
            this.state.persistent.votedFor = null;
            this.transitionTo(NodeState.FOLLOWER, `discovered higher term ${term}`);
            return true;
        }
        return false;
    }

    // ============================================================================
    // Timer Management (Person 2 will enhance these)
    // ============================================================================

    /**
     * Reset the election timer
     * Called when receiving valid heartbeat or granting vote
     */
    resetElectionTimer(): void {
        if (this.electionTimer) {
            clearTimeout(this.electionTimer);
        }

        const [min, max] = this.config.electionTimeout;
        const timeout = Math.floor(Math.random() * (max - min + 1)) + min;

        this.electionTimer = setTimeout(() => {
            this.onElectionTimeout();
        }, timeout);

        logger.debug(`Election timer reset to ${timeout}ms`);
    }

    /**
     * Handle election timeout
     * Person 2 will implement the full election logic
     */
    private onElectionTimeout(): void {
        if (this.state.nodeState === NodeState.LEADER) {
            return; // Leaders don't have election timeout
        }

        logger.info('Election timeout, starting election');
        this.startElection();
    }

    /**
     * Start the heartbeat timer (Leader only)
     */
    private startHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        // Send initial heartbeat immediately
        this.sendHeartbeat();

        // Then send periodically
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.config.heartbeatInterval);

        logger.debug(`Heartbeat started with interval ${this.config.heartbeatInterval}ms`);
    }

    /**
     * Stop the heartbeat timer
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ============================================================================
    // Leader Election (Person 2 - TODO: Full implementation)
    // ============================================================================

    /**
     * Start a leader election
     * 
     * TODO for Person 2:
     * 1. Increment current term
     * 2. Vote for self
     * 3. Reset election timer
     * 4. Send RequestVote RPCs to all other servers
     * 5. If received majority votes, become leader
     * 6. If received AppendEntries from new leader, convert to follower
     */
    startElection(): void {
        // Transition to candidate
        this.transitionTo(NodeState.CANDIDATE, 'starting election');

        // Increment term and vote for self
        this.state.persistent.currentTerm++;
        this.state.persistent.votedFor = this.config.nodeId;

        const term = this.state.persistent.currentTerm;
        const lastLogIndex = getLastLogIndex(this.state.persistent.log);
        const lastLogTerm = getLastLogTerm(this.state.persistent.log);

        logger.info(`Starting election for term ${term}`);

        // Reset election timer for this election
        this.resetElectionTimer();

        // Request votes from all other servers
        // TODO: Person 2 - implement vote collection and majority check
        const request: RequestVoteRequest = {
            term,
            candidateId: this.config.nodeId,
            lastLogIndex,
            lastLogTerm,
        };

        let votesReceived = 1; // Vote for self
        const votesNeeded = Math.floor(this.state.clusterConfig.length / 2) + 1;

        // Send RequestVote to all other nodes
        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);

        for (const node of otherNodes) {
            this.rpcClient.call<RequestVoteResponse>(node, 'request_vote', request)
                .then(response => {
                    // Check if we're still a candidate
                    if (this.state.nodeState !== NodeState.CANDIDATE) {
                        return;
                    }

                    // Check for higher term
                    if (response.term > this.state.persistent.currentTerm) {
                        this.updateTerm(response.term);
                        return;
                    }

                    // Count vote
                    if (response.voteGranted && response.term === this.state.persistent.currentTerm) {
                        votesReceived++;
                        logger.info(`Received vote from ${node.id}, total: ${votesReceived}/${votesNeeded}`);

                        // Check if we have majority
                        if (votesReceived >= votesNeeded) {
                            this.transitionTo(NodeState.LEADER, `won election with ${votesReceived} votes`);
                        }
                    }
                })
                .catch(err => {
                    logger.debug(`RequestVote to ${node.id} failed: ${err.message}`);
                });
        }

        // Handle single node cluster
        if (votesReceived >= votesNeeded) {
            this.transitionTo(NodeState.LEADER, `won election with ${votesReceived} votes`);
        }
    }

    /**
     * Handle incoming RequestVote RPC
     * 
     * @param request - RequestVote request
     * @returns RequestVote response
     */
    async handleRequestVote(request: RequestVoteRequest): Promise<RequestVoteResponse> {
        // TODO for Person 2: Full implementation
        // Current basic implementation:

        const currentTerm = this.state.persistent.currentTerm;

        // Reply false if term < currentTerm
        if (request.term < currentTerm) {
            return { term: currentTerm, voteGranted: false };
        }

        // Update term if needed
        if (request.term > currentTerm) {
            this.updateTerm(request.term);
        }

        // Check if we can grant vote
        const votedFor = this.state.persistent.votedFor;
        const canVote = votedFor === null || votedFor === request.candidateId;

        // Check if candidate's log is at least as up-to-date as ours
        const lastLogIndex = getLastLogIndex(this.state.persistent.log);
        const lastLogTerm = getLastLogTerm(this.state.persistent.log);
        const logUpToDate =
            request.lastLogTerm > lastLogTerm ||
            (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

        const voteGranted = canVote && logUpToDate;

        if (voteGranted) {
            this.state.persistent.votedFor = request.candidateId;
            this.resetElectionTimer();
            logger.info(`Granted vote to ${request.candidateId} for term ${request.term}`);
        } else {
            logger.debug(`Denied vote to ${request.candidateId}: canVote=${canVote}, logUpToDate=${logUpToDate}`);
        }

        return { term: this.state.persistent.currentTerm, voteGranted };
    }

    // ============================================================================
    // Heartbeat (Person 2 - TODO: Enhanced implementation)
    // ============================================================================

    /**
     * Send heartbeat to all followers
     * 
     * TODO for Person 2: This is called by Person 3's replication logic too
     */
    sendHeartbeat(): void {
        if (this.state.nodeState !== NodeState.LEADER) {
            return;
        }

        logger.debug('Sending heartbeat to followers');

        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);

        for (const node of otherNodes) {
            // TODO: Person 3 will implement proper log replication here
            // For now, just send empty entries (pure heartbeat)
            const prevLogIndex = this.state.leaderState?.nextIndex.get(node.id)! - 1 || 0;
            const prevLogTerm = this.state.persistent.log[prevLogIndex]?.term || 0;

            const request: AppendEntriesRequest = {
                term: this.state.persistent.currentTerm,
                leaderId: this.config.nodeId,
                prevLogIndex,
                prevLogTerm,
                entries: [],
                leaderCommit: this.state.volatile.commitIndex,
            };

            this.rpcClient.call<AppendEntriesResponse>(node, 'append_entries', request)
                .then(response => {
                    if (response.term > this.state.persistent.currentTerm) {
                        this.updateTerm(response.term);
                    }
                })
                .catch(err => {
                    logger.debug(`Heartbeat to ${node.id} failed: ${err.message}`);
                });
        }
    }

    // ============================================================================
    // Log Replication (Person 3 - TODO: Full implementation)
    // ============================================================================

    /**
     * Handle incoming AppendEntries RPC
     * 
     * TODO for Person 3: Full log replication implementation
     * 
     * @param request - AppendEntries request
     * @returns AppendEntries response
     */
    async handleAppendEntries(request: AppendEntriesRequest): Promise<AppendEntriesResponse> {
        // Basic implementation - Person 3 will enhance

        const currentTerm = this.state.persistent.currentTerm;

        // Reply false if term < currentTerm
        if (request.term < currentTerm) {
            return { term: currentTerm, success: false };
        }

        // Update term and convert to follower if needed
        if (request.term > currentTerm) {
            this.updateTerm(request.term);
        }

        // Recognize leader
        if (this.state.nodeState !== NodeState.FOLLOWER) {
            this.transitionTo(NodeState.FOLLOWER, `received AppendEntries from leader ${request.leaderId}`);
        }
        this.state.leaderId = request.leaderId;

        // Reset election timer (valid heartbeat received)
        this.resetElectionTimer();

        // TODO for Person 3: Implement log consistency check and entry appending
        // For now, always return success for heartbeats
        if (request.entries.length === 0) {
            return { term: this.state.persistent.currentTerm, success: true };
        }

        // Basic log handling (Person 3 will implement fully)
        // Check if log contains entry at prevLogIndex with prevLogTerm
        const log = this.state.persistent.log;
        if (request.prevLogIndex > 0) {
            if (log.length <= request.prevLogIndex ||
                log[request.prevLogIndex].term !== request.prevLogTerm) {
                return { term: this.state.persistent.currentTerm, success: false };
            }
        }

        // Append new entries
        for (const entry of request.entries) {
            if (entry.index < log.length) {
                if (log[entry.index].term !== entry.term) {
                    // Delete conflicting entries
                    log.splice(entry.index);
                    log.push(entry);
                }
            } else {
                log.push(entry);
            }
        }

        // Update commit index
        if (request.leaderCommit > this.state.volatile.commitIndex) {
            this.state.volatile.commitIndex = Math.min(
                request.leaderCommit,
                getLastLogIndex(log)
            );
            // TODO: Person 3 - Apply committed entries to state machine
        }

        return {
            term: this.state.persistent.currentTerm,
            success: true,
            matchIndex: getLastLogIndex(log)
        };
    }

    /**
     * Execute a client command
     * 
     * TODO for Person 3: Full log replication before responding
     * 
     * @param command - Command to execute
     * @param args - Command arguments
     * @returns Command result
     */
    async executeCommand(command: string, args: string[]): Promise<string> {
        // Special case: ping doesn't need log replication
        if (command === 'ping') {
            return 'PONG';
        }

        // Read-only commands can be executed immediately on leader
        if (command === 'get' || command === 'strln') {
            return executeKvCommand(this.kvStore, command, args);
        }

        // Write commands need to go through log replication
        // TODO for Person 3: 
        // 1. Create log entry with command
        // 2. Append to local log
        // 3. Replicate to followers
        // 4. Wait for majority acknowledgment
        // 5. Commit and apply to state machine
        // 6. Return result

        // For now, just execute directly (Person 3 will add replication)
        logger.warn('Executing command without replication (Person 3 TODO)');
        return executeKvCommand(this.kvStore, command, args);
    }

    // ============================================================================
    // Membership Changes (Person 1)
    // ============================================================================

    /**
     * Add a new server to the cluster
     * 
     * This implements the membership change protocol from the Raft paper.
     * The change is committed through the log like any other entry.
     * 
     * @param request - AddServer request
     * @returns AddServer response
     */
    async handleAddServer(request: AddServerRequest): Promise<AddServerResponse> {
        const { newServer } = request;

        logger.info(`Adding server ${newServer.id} (${newServer.address}:${newServer.port})`);

        // Check if server already exists
        const existing = this.state.clusterConfig.find(s => s.id === newServer.id);
        if (existing) {
            logger.warn(`Server ${newServer.id} already in cluster`);
            return {
                success: false,
                leaderId: this.config.nodeId,
                error: 'Server already in cluster',
            };
        }

        // Create configuration change entry
        const configChange: ConfigChange = {
            type: 'add_server',
            server: newServer,
        };

        const entry: LogEntry = {
            term: this.state.persistent.currentTerm,
            index: getLastLogIndex(this.state.persistent.log) + 1,
            entryType: 'config',
            configChange,
            timestamp: Date.now(),
        };

        // Append to local log
        this.state.persistent.log.push(entry);
        logger.info(`Appended config change entry at index ${entry.index}`);

        // TODO: Person 3 - Replicate to followers and wait for majority
        // For now, immediately apply the change

        // Add to cluster configuration
        this.state.clusterConfig.push(newServer);

        // Initialize leader state for new server
        if (this.state.leaderState) {
            this.state.leaderState.nextIndex.set(newServer.id, entry.index + 1);
            this.state.leaderState.matchIndex.set(newServer.id, 0);
        }

        logger.info(`Server ${newServer.id} added to cluster. New cluster size: ${this.state.clusterConfig.length}`);

        return {
            success: true,
            leaderId: this.config.nodeId,
        };
    }

    /**
     * Remove a server from the cluster
     * 
     * @param request - RemoveServer request
     * @returns RemoveServer response
     */
    async handleRemoveServer(request: RemoveServerRequest): Promise<RemoveServerResponse> {
        const { serverId } = request;

        logger.info(`Removing server ${serverId}`);

        // Check if server exists
        const serverIndex = this.state.clusterConfig.findIndex(s => s.id === serverId);
        if (serverIndex === -1) {
            logger.warn(`Server ${serverId} not found in cluster`);
            return {
                success: false,
                leaderId: this.config.nodeId,
                error: 'Server not found in cluster',
            };
        }

        const serverToRemove = this.state.clusterConfig[serverIndex];

        // Create configuration change entry
        const configChange: ConfigChange = {
            type: 'remove_server',
            server: serverToRemove,
        };

        const entry: LogEntry = {
            term: this.state.persistent.currentTerm,
            index: getLastLogIndex(this.state.persistent.log) + 1,
            entryType: 'config',
            configChange,
            timestamp: Date.now(),
        };

        // Append to local log
        this.state.persistent.log.push(entry);
        logger.info(`Appended config change entry at index ${entry.index}`);

        // TODO: Person 3 - Replicate to followers and wait for majority
        // For now, immediately apply the change

        // Remove from cluster configuration
        this.state.clusterConfig.splice(serverIndex, 1);

        // Clean up leader state for removed server
        if (this.state.leaderState) {
            this.state.leaderState.nextIndex.delete(serverId);
            this.state.leaderState.matchIndex.delete(serverId);
        }

        logger.info(`Server ${serverId} removed from cluster. New cluster size: ${this.state.clusterConfig.length}`);

        // If we're removing ourselves, step down
        if (serverId === this.config.nodeId) {
            logger.info('Removed self from cluster, stepping down');
            this.transitionTo(NodeState.FOLLOWER, 'removed self from cluster');
            // Stop the node after responding
            setTimeout(() => this.stop(), 100);
        }

        return {
            success: true,
            leaderId: this.config.nodeId,
        };
    }

    // ============================================================================
    // Cluster Configuration
    // ============================================================================

    /**
     * Get the current cluster configuration
     */
    getClusterConfig(): ServerInfo[] {
        return [...this.state.clusterConfig];
    }

    /**
     * Get the number of nodes required for a quorum
     */
    getQuorumSize(): number {
        return Math.floor(this.state.clusterConfig.length / 2) + 1;
    }
}
