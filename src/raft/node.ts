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
import { CommandType } from './types';
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

        logger.info(`Initialized with ${config.clusterNodes.length} nodes in cluster${config.joinMode ? ' (JOIN MODE - elections disabled)' : ''}`);
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
        if (leader) {
            return `${leader.address}:${leader.port}`;
        }
        // Fallback: if leader is not in our config (e.g., new node that won election),
        // assume the leaderId is the hostname and use default port
        return `${this.state.leaderId}:3000`;
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

        // In join mode, don't start elections - wait to be added by leader
        if (this.config.joinMode) {
            logger.debug('Join mode active, skipping election');
            this.resetElectionTimer();
            return;
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
     * Also handles log replication by sending pending entries
     */
    sendHeartbeat(): void {
        if (this.state.nodeState !== NodeState.LEADER) {
            return;
        }

        logger.debug('Sending heartbeat to followers');

        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);

        for (const node of otherNodes) {
            this.replicateToFollower(node);
        }
    }

    /**
     * Replicate log entries to a specific follower
     * 
     * @param follower - Follower node info
     */
    private async replicateToFollower(follower: ServerInfo): Promise<void> {
        if (this.state.nodeState !== NodeState.LEADER || !this.state.leaderState) {
            return;
        }

        const nextIndex = this.state.leaderState.nextIndex.get(follower.id) || 1;
        const prevLogIndex = nextIndex - 1;
        const prevLogTerm = this.state.persistent.log[prevLogIndex]?.term || 0;

        // Get entries to send (from nextIndex to end of log)
        const entries = this.state.persistent.log.slice(nextIndex);

        const request: AppendEntriesRequest = {
            term: this.state.persistent.currentTerm,
            leaderId: this.config.nodeId,
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this.state.volatile.commitIndex,
        };

        if (entries.length > 0) {
            logger.info(`[LEADER] Sending ${entries.length} entries to ${follower.id} (nextIndex=${nextIndex}, commitIndex=${this.state.volatile.commitIndex})`);
        }

        try {
            const response = await this.rpcClient.call<AppendEntriesResponse>(follower, 'append_entries', request);

            // Update term if we're behind
            if (response.term > this.state.persistent.currentTerm) {
                this.updateTerm(response.term);
                return;
            }

            // If successful, update nextIndex and matchIndex
            if (response.success) {
                if (entries.length > 0) {
                    const lastIndex = entries[entries.length - 1].index;
                    this.state.leaderState.nextIndex.set(follower.id, lastIndex + 1);
                    this.state.leaderState.matchIndex.set(follower.id, lastIndex);
                    logger.info(`[LEADER] ✓ Successfully replicated to ${follower.id} up to index ${lastIndex}`);
                }

                // Try to commit entries
                this.tryCommitEntries();
            } else {
                // If failed due to log inconsistency, decrement nextIndex and retry
                const currentNext = this.state.leaderState.nextIndex.get(follower.id) || 1;
                this.state.leaderState.nextIndex.set(follower.id, Math.max(1, currentNext - 1));
                logger.warn(`[LEADER] ✗ Log inconsistency with ${follower.id}, decremented nextIndex to ${Math.max(1, currentNext - 1)}`);
            }
        } catch (err: any) {
            logger.debug(`Replication to ${follower.id} failed: ${err.message}`);
        }
    }

    /**
     * Try to commit log entries based on majority replication
     */
    private tryCommitEntries(): void {
        if (this.state.nodeState !== NodeState.LEADER || !this.state.leaderState) {
            return;
        }

        const lastLogIndex = getLastLogIndex(this.state.persistent.log);

        // Find the highest index N where:
        // - N > commitIndex
        // - A majority of matchIndex[i] >= N
        // - log[N].term == currentTerm
        for (let n = lastLogIndex; n > this.state.volatile.commitIndex; n--) {
            const entry = this.state.persistent.log[n];
            if (!entry || entry.term !== this.state.persistent.currentTerm) {
                continue;
            }

            // Count how many nodes have replicated this entry
            let replicaCount = 1; // Count self
            for (const matchIndex of this.state.leaderState.matchIndex.values()) {
                if (matchIndex >= n) {
                    replicaCount++;
                }
            }

            // Check if we have majority
            const quorumSize = this.getQuorumSize();
            if (replicaCount >= quorumSize) {
                logger.info(`Committing entries up to index ${n} (replicated on ${replicaCount}/${this.state.clusterConfig.length} nodes)`);
                this.commitLogEntries(n);
                break;
            }
        }
    }

    /**
     * Commit log entries up to the given index
     * Only updates commitIndex, actual application happens in applyCommittedEntries
     * 
     * @param commitIndex - Index to commit up to
     */
    private commitLogEntries(commitIndex: number): void {
        const oldCommitIndex = this.state.volatile.commitIndex;
        this.state.volatile.commitIndex = commitIndex;
        logger.info(`Leader committed entries up to index ${commitIndex} (was ${oldCommitIndex})`);

        // Trigger application of committed entries
        this.applyCommittedEntries(commitIndex);
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

        // Heartbeat with no entries
        if (request.entries.length === 0) {
            logger.debug(`[FOLLOWER] Received heartbeat from ${request.leaderId} (leaderCommit=${request.leaderCommit})`);
            // Still need to update commit index and apply entries
            if (request.leaderCommit > this.state.volatile.commitIndex) {
                const newCommitIndex = Math.min(
                    request.leaderCommit,
                    getLastLogIndex(this.state.persistent.log)
                );
                this.applyCommittedEntries(newCommitIndex);
            }
            return { term: this.state.persistent.currentTerm, success: true };
        }

        logger.info(`[FOLLOWER] Received ${request.entries.length} entries from ${request.leaderId} (prevIndex=${request.prevLogIndex}, prevTerm=${request.prevLogTerm})`);

        // Log replication - check if log contains entry at prevLogIndex with prevLogTerm
        const log = this.state.persistent.log;
        if (request.prevLogIndex > 0) {
            // Check if we have the previous entry
            if (log.length <= request.prevLogIndex) {
                logger.debug(`Log too short: have ${log.length}, need ${request.prevLogIndex + 1}`);
                return { term: this.state.persistent.currentTerm, success: false };
            }
            // Check if term matches
            if (log[request.prevLogIndex].term !== request.prevLogTerm) {
                logger.debug(`Term mismatch at index ${request.prevLogIndex}: have ${log[request.prevLogIndex].term}, need ${request.prevLogTerm}`);
                return { term: this.state.persistent.currentTerm, success: false };
            }
        }

        // Append new entries
        let appendedCount = 0;
        for (const entry of request.entries) {
            if (entry.index < log.length) {
                // Check for conflict
                if (log[entry.index].term !== entry.term) {
                    // Delete conflicting entry and all that follow
                    logger.warn(`[FOLLOWER] Conflict at index ${entry.index}, truncating log from ${entry.index}`);
                    log.splice(entry.index);
                    log.push(entry);
                    appendedCount++;
                }
                // Entry already exists and matches, skip
            } else {
                // Append new entry
                log.push(entry);
                appendedCount++;
            }
        }

        if (appendedCount > 0) {
            logger.info(`[FOLLOWER] ✓ Appended ${appendedCount} new entries, log size now ${log.length}`);
        }

        // Update commit index and apply entries
        if (request.leaderCommit > this.state.volatile.commitIndex) {
            const newCommitIndex = Math.min(
                request.leaderCommit,
                getLastLogIndex(log)
            );
            this.applyCommittedEntries(newCommitIndex);
        }

        return {
            term: this.state.persistent.currentTerm,
            success: true,
            matchIndex: getLastLogIndex(log)
        };
    }

    /**
     * Apply committed entries to the state machine
     * 
     * @param commitIndex - Index to commit up to
     */
    private applyCommittedEntries(commitIndex: number): void {
        for (let i = this.state.volatile.lastApplied + 1; i <= commitIndex; i++) {
            const entry = this.state.persistent.log[i];
            if (entry.entryType === 'command' && entry.command) {
                // ✅ Eksekusi di sini - BENAR
                const args = entry.command.value !== undefined 
                    ? [entry.command.key, entry.command.value] 
                    : [entry.command.key];
                const result = executeKvCommand(this.kvStore, entry.command.type, args);
                logger.info(`Applied command at index ${i}: ${entry.command.type} ${entry.command.key}`);
            }
            this.state.volatile.lastApplied = i;
        }
    }

    /**
     * Apply a configuration change to the cluster
     * 
     * @param configChange - Configuration change to apply
     */
    private applyConfigChange(configChange: ConfigChange): void {
        if (configChange.type === 'add_server') {
            const existing = this.state.clusterConfig.find(s => s.id === configChange.server.id);
            if (!existing) {
                this.state.clusterConfig.push(configChange.server);
                logger.info(`Applied add_server: ${configChange.server.id}`);
            }
        } else if (configChange.type === 'remove_server') {
            const index = this.state.clusterConfig.findIndex(s => s.id === configChange.server.id);
            if (index !== -1) {
                this.state.clusterConfig.splice(index, 1);
                logger.info(`Applied remove_server: ${configChange.server.id}`);
            }
        }
    }

    /**
     * Execute a client command
     * 
     * Implements full log replication for write commands
     * 
     * @param command - Command to execute
     * @param args - Command arguments
     * @returns Command result
     */
    async executeCommand(command: string, args: string[]): Promise<string> {
        // Special case: ping
        if (command === 'ping') {
            return 'PONG';
        }

        // Read-only commands - bisa langsung execute tanpa log replication
        if (command === 'get' || command === 'strln') {
            return executeKvCommand(this.kvStore, command, args);
        }

        // Write commands - melalui log replication
        const commandEntry: Command = {
            type: command as CommandType,
            key: args[0],
            value: args[1],
        };

        const entry: LogEntry = {
            term: this.state.persistent.currentTerm,
            index: getLastLogIndex(this.state.persistent.log) + 1,
            entryType: 'command',
            command: commandEntry,
            timestamp: Date.now(),
        };

        // Append to local log
        this.state.persistent.log.push(entry);
        logger.info(`Appended command entry at index ${entry.index}: ${command} ${args[0]}`);

        // Replicate to followers
        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);
        for (const node of otherNodes) {
            this.replicateToFollower(node);
        }

        // Wait for commit
        const startTime = Date.now();
        const timeout = 5000;

        while (Date.now() - startTime < timeout) {
            if (this.state.volatile.lastApplied >= entry.index) {
                logger.info(`Command at index ${entry.index} committed and applied`);
                
                // ✅ PERBAIKAN: Jangan execute lagi!
                // Entry sudah di-apply di applyCommittedEntries()
                // Untuk write commands, cukup return OK message
                if (command === 'set' || command === 'append') {
                    return 'OK';
                } else if (command === 'del') {
                    return '1'; // atau '0' tergantung apakah key ditemukan
                }
                
                // Jika perlu return value hasil eksekusi, simpan hasil di entry
                // atau read dari state machine (tapi ini berisiko race condition)
                return 'OK';
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        throw new Error('Command replication timeout');
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

        // Replicate to followers
        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);
        for (const node of otherNodes) {
            this.replicateToFollower(node);
        }

        // Add to cluster configuration (apply immediately for now)
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

        // Replicate to followers
        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);
        for (const node of otherNodes) {
            this.replicateToFollower(node);
        }

        // Remove from cluster configuration (apply immediately for now)
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
