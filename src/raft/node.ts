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

    // ============================================================================
    // Log Replication (Person 3)
    // ============================================================================

    /** Timeout for waiting for command commit (ms) */
    private static readonly COMMAND_TIMEOUT = 10000;

    /**
     * Pending commands waiting for commit
     * Maps log index to promise resolvers and command details
     */
    private pendingCommands: Map<number, {
        resolve: (result: string) => void;
        reject: (error: Error) => void;
        command: Command;
    }> = new Map();

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

        const votesNeeded = Math.floor(this.state.clusterConfig.length / 2) + 1;

        // Send RequestVote to all other nodes
        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);

        // Collect all vote promises to avoid race condition
        const votePromises = otherNodes.map(node =>
            this.rpcClient.call<RequestVoteResponse>(node, 'request_vote', request)
                .catch(err => {
                    logger.debug(`RequestVote to ${node.id} failed: ${err.message}`);
                    // Return rejected vote on error
                    return { term: 0, voteGranted: false } as RequestVoteResponse;
                })
        );

        // Wait for all responses and count votes atomically
        Promise.allSettled(votePromises).then(results => {
            // Check if still candidate (might have become follower)
            if (this.state.nodeState !== NodeState.CANDIDATE) {
                logger.debug('No longer candidate, ignoring election results');
                return;
            }

            let votesReceived = 1; // Self vote

            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const response = result.value;

                    // Check for higher term
                    if (response.term > this.state.persistent.currentTerm) {
                        this.updateTerm(response.term);
                        return;
                    }

                    // Count vote
                    if (response.voteGranted && response.term === this.state.persistent.currentTerm) {
                        votesReceived++;
                    }
                }
            }

            logger.info(`Election result: ${votesReceived}/${votesNeeded} votes`);

            // Check if won election
            if (votesReceived >= votesNeeded) {
                this.transitionTo(NodeState.LEADER, `won election with ${votesReceived} votes`);
            } else {
                logger.info(`Did not win election, only got ${votesReceived}/${votesNeeded} votes`);
            }
        });

        // Handle single node cluster (no other nodes to vote)
        if (otherNodes.length === 0) {
            logger.info('Single node cluster, becoming leader immediately');
            this.transitionTo(NodeState.LEADER, 'single node cluster');
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
    // Heartbeat (Person 3 Enhanced)
    // ============================================================================

    /**
     * Send heartbeat to all followers (Person 3 Enhanced)
     * 
     * Now uses the replicateToAllFollowers method which sends
     * actual log entries along with heartbeat. This serves dual purpose:
     * 1. Maintains leader authority (heartbeat)
     * 2. Replicates any pending log entries
     */
    private heartbeatCounter = 0;
    sendHeartbeat(): void {
        if (this.state.nodeState !== NodeState.LEADER) {
            return;
        }

        // Log heartbeat periodically (every 5 seconds = 100 heartbeats)
        this.heartbeatCounter++;
        if (this.heartbeatCounter % 100 === 0) {
            logger.info(`[HEARTBEAT] Leader ${this.config.nodeId} sending heartbeat to followers (term=${this.state.persistent.currentTerm})`);
        }

        // Use the replication method which includes log entries
        this.replicateToAllFollowers();
    }

    // ============================================================================
    // Log Replication - Follower Side (Person 3)
    // ============================================================================

    /**
     * Handle incoming AppendEntries RPC (Person 3 - Full Implementation)
     * 
     * This method handles both heartbeats and log replication:
     * 1. Validates term and recognizes leader
     * 2. Checks log consistency at prevLogIndex
     * 3. Appends new entries (handling conflicts)
     * 4. Updates commit index and applies entries to state machine
     * 
     * @param request - AppendEntries request from leader
     * @returns AppendEntries response
     */
    async handleAppendEntries(request: AppendEntriesRequest): Promise<AppendEntriesResponse> {
        const currentTerm = this.state.persistent.currentTerm;

        // Step 1: Reply false if term < currentTerm (§5.1)
        if (request.term < currentTerm) {
            logger.debug(`Rejecting AppendEntries: term ${request.term} < currentTerm ${currentTerm}`);
            return { term: currentTerm, success: false };
        }

        // Step 2: Update term and convert to follower if needed
        if (request.term > currentTerm) {
            this.updateTerm(request.term);
        }

        // Recognize the leader
        if (this.state.nodeState !== NodeState.FOLLOWER) {
            this.transitionTo(NodeState.FOLLOWER, `received AppendEntries from leader ${request.leaderId}`);
        }
        this.state.leaderId = request.leaderId;

        // Reset election timer (valid heartbeat received)
        this.resetElectionTimer();

        const log = this.state.persistent.log;

        // Step 3: Reply false if log doesn't contain entry at prevLogIndex with prevLogTerm (§5.3)
        if (request.prevLogIndex > 0) {
            if (request.prevLogIndex >= log.length) {
                // Log is too short
                logger.debug(`Log consistency check failed: prevLogIndex=${request.prevLogIndex} >= log.length=${log.length}`);
                return { term: this.state.persistent.currentTerm, success: false };
            }
            if (log[request.prevLogIndex].term !== request.prevLogTerm) {
                // Term mismatch at prevLogIndex
                logger.debug(`Log consistency check failed: log[${request.prevLogIndex}].term=${log[request.prevLogIndex].term} !== prevLogTerm=${request.prevLogTerm}`);
                return { term: this.state.persistent.currentTerm, success: false };
            }
        }

        // Step 4: If existing entry conflicts with new one, delete it and all following (§5.3)
        // Step 5: Append any new entries not already in the log
        if (request.entries.length > 0) {
            for (const entry of request.entries) {
                if (entry.index < log.length) {
                    // Entry exists at this index
                    if (log[entry.index].term !== entry.term) {
                        // Conflict! Delete this entry and everything after
                        logger.info(`Conflict at index ${entry.index}: deleting entries from ${entry.index} onwards`);
                        log.splice(entry.index);
                        log.push(entry);
                    }
                    // If terms match, entry is already there (idempotent)
                } else {
                    // New entry, append it
                    log.push(entry);
                    logger.debug(`Appended entry at index ${entry.index}`);
                }
            }
        }

        // Step 6: If leaderCommit > commitIndex, update commitIndex (§5.3)
        if (request.leaderCommit > this.state.volatile.commitIndex) {
            const oldCommitIndex = this.state.volatile.commitIndex;
            this.state.volatile.commitIndex = Math.min(
                request.leaderCommit,
                getLastLogIndex(log)
            );

            if (this.state.volatile.commitIndex > oldCommitIndex) {
                logger.info(`Updated commitIndex from ${oldCommitIndex} to ${this.state.volatile.commitIndex}`);

                // Apply committed entries to state machine
                this.applyCommittedEntries();
            }
        }

        return {
            term: this.state.persistent.currentTerm,
            success: true,
            matchIndex: getLastLogIndex(log)
        };
    }

    /**
     * Execute a client command (Person 3 - Full Implementation)
     * 
     * For write commands, this method:
     * 1. Creates a log entry with the command
     * 2. Appends to local log
     * 3. Triggers replication to followers
     * 4. Waits for majority acknowledgment (commit)
     * 5. Applies to state machine and returns result
     * 
     * @param command - Command to execute (set, get, append, del, etc.)
     * @param args - Command arguments
     * @returns Command result
     */
    async executeCommand(command: string, args: string[]): Promise<string> {
        // Special case: ping doesn't need log replication
        if (command === 'ping') {
            return 'PONG';
        }

        // Read-only commands can be executed immediately from state machine
        // These read from the committed state, so they're always consistent
        if (command === 'get' || command === 'strln') {
            return executeKvCommand(this.kvStore, command, args);
        }

        // Write commands need to go through log replication
        // Build the Command object based on command type
        const cmd: Command = this.buildCommand(command, args);

        // Create log entry
        const entry: LogEntry = {
            term: this.state.persistent.currentTerm,
            index: getLastLogIndex(this.state.persistent.log) + 1,
            entryType: 'command',
            command: cmd,
            timestamp: Date.now(),
        };

        // Append to local log
        this.state.persistent.log.push(entry);
        logger.info(`Appended command entry at index ${entry.index}: ${command} ${args.join(' ')}`);

        // Update our own matchIndex (leader always matches itself)
        if (this.state.leaderState) {
            this.state.leaderState.matchIndex.set(this.config.nodeId, entry.index);
        }

        // Create a promise that will be resolved when the entry is committed
        return new Promise<string>((resolve, reject) => {
            // Store the pending command
            this.pendingCommands.set(entry.index, {
                resolve,
                reject,
                command: cmd,
            });

            // Set timeout for command
            const timeoutId = setTimeout(() => {
                if (this.pendingCommands.has(entry.index)) {
                    this.pendingCommands.delete(entry.index);
                    reject(new Error('Command timed out waiting for commit'));
                }
            }, RaftNode.COMMAND_TIMEOUT);

            // Store timeout ID for cleanup
            const pending = this.pendingCommands.get(entry.index);
            if (pending) {
                (pending as any).timeoutId = timeoutId;
            }

            // Trigger immediate replication to all followers
            this.replicateToAllFollowers();
        });
    }

    /**
     * Build a Command object from command string and args
     * 
     * @param command - Command type (set, del, append)
     * @param args - Command arguments
     * @returns Command object
     */
    private buildCommand(command: string, args: string[]): Command {
        const cmdType = command.toLowerCase() as 'set' | 'del' | 'append';

        switch (cmdType) {
            case 'set':
                return { type: 'set', key: args[0], value: args[1] || '' };
            case 'del':
                return { type: 'del', key: args[0] };
            case 'append':
                return { type: 'append', key: args[0], value: args[1] || '' };
            default:
                throw new Error(`Unknown command type: ${command}`);
        }
    }

    /**
     * Replicate log entries to all followers (Person 3)
     * 
     * Called after a new entry is appended or periodically during heartbeat.
     * Sends AppendEntries to each follower with entries they're missing.
     */
    private replicateToAllFollowers(): void {
        if (this.state.nodeState !== NodeState.LEADER) {
            return;
        }

        const otherNodes = this.state.clusterConfig.filter(s => s.id !== this.config.nodeId);

        for (const node of otherNodes) {
            this.replicateToFollower(node);
        }
    }

    /**
     * Replicate log entries to a single follower (Person 3)
     * 
     * Sends AppendEntries RPC with entries from nextIndex onwards.
     * On success: updates matchIndex and checks for commit.
     * On failure: decrements nextIndex and retries.
     * 
     * @param node - Follower to replicate to
     */
    private replicateToFollower(node: ServerInfo): void {
        if (!this.state.leaderState) {
            return;
        }

        // Get the next index for this follower
        const nextIndex = this.state.leaderState.nextIndex.get(node.id) || 1;
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

        // Log only if sending actual entries (not just heartbeat)
        if (entries.length > 0) {
            logger.debug(`Replicating ${entries.length} entries to ${node.id} (prevLogIndex=${prevLogIndex})`);
        }

        this.rpcClient.call<AppendEntriesResponse>(node, 'append_entries', request)
            .then(response => {
                // Check for higher term
                if (response.term > this.state.persistent.currentTerm) {
                    this.updateTerm(response.term);
                    return;
                }

                if (!this.state.leaderState) {
                    return; // No longer leader
                }

                if (response.success) {
                    // Update nextIndex and matchIndex for this follower
                    const newMatchIndex = response.matchIndex || (prevLogIndex + entries.length);
                    this.state.leaderState.matchIndex.set(node.id, newMatchIndex);
                    this.state.leaderState.nextIndex.set(node.id, newMatchIndex + 1);

                    if (entries.length > 0) {
                        logger.debug(`Replication to ${node.id} succeeded, matchIndex=${newMatchIndex}`);
                    }

                    // Check if we can advance the commit index
                    this.updateCommitIndex();
                } else {
                    // Decrement nextIndex and retry
                    const newNextIndex = Math.max(1, nextIndex - 1);
                    this.state.leaderState.nextIndex.set(node.id, newNextIndex);
                    logger.debug(`Replication to ${node.id} failed, retrying with nextIndex=${newNextIndex}`);

                    // Retry replication immediately
                    setTimeout(() => this.replicateToFollower(node), 200);
                }
            })
            .catch(err => {
                // logger.debug(`Replication to ${node.id} failed: ${err.message}`);
            });
    }

    /**
     * Update the commit index based on majority matchIndex (Person 3)
     * 
     * Finds the highest N such that a majority of matchIndex[i] >= N
     * and log[N].term == currentTerm. Then advances commitIndex to N.
     */
    private updateCommitIndex(): void {
        if (!this.state.leaderState) {
            return;
        }

        const log = this.state.persistent.log;
        const currentTerm = this.state.persistent.currentTerm;

        // Collect all matchIndex values (including leader's own)
        const matchIndices: number[] = [];
        for (const [serverId, matchIndex] of this.state.leaderState.matchIndex) {
            // Only count servers still in the cluster
            if (this.state.clusterConfig.find(s => s.id === serverId)) {
                matchIndices.push(matchIndex);
            }
        }

        // Sort in descending order
        matchIndices.sort((a, b) => b - a);

        // Find the majority position (quorum - 1 because 0-indexed)
        const quorumIndex = Math.floor(this.state.clusterConfig.length / 2);

        // The commit index is the matchIndex at the quorum position
        // This is the highest index replicated to a majority
        if (quorumIndex < matchIndices.length) {
            const newCommitIndex = matchIndices[quorumIndex];

            // Only commit entries from current term (Raft safety guarantee)
            // This prevents committing entries from previous terms without
            // a new entry in the current term
            if (newCommitIndex > this.state.volatile.commitIndex &&
                log[newCommitIndex]?.term === currentTerm) {

                logger.info(`Advancing commitIndex from ${this.state.volatile.commitIndex} to ${newCommitIndex}`);
                this.state.volatile.commitIndex = newCommitIndex;

                // Apply newly committed entries to state machine
                this.applyCommittedEntries();
            }
        }
    }

    /**
     * Apply committed entries to the state machine (Person 3)
     * 
     * Applies all entries from lastApplied+1 to commitIndex.
     * For command entries: executes on KV store.
     * For config entries: updates cluster configuration.
     * Resolves pending command promises with results.
     */
    private applyCommittedEntries(): void {
        const log = this.state.persistent.log;

        while (this.state.volatile.lastApplied < this.state.volatile.commitIndex) {
            const indexToApply = this.state.volatile.lastApplied + 1;
            const entry = log[indexToApply];

            if (!entry) {
                logger.error(`No entry at index ${indexToApply} to apply`);
                break;
            }

            logger.info(`Applying entry at index ${indexToApply}: type=${entry.entryType}`);

            let result: string = '';

            if (entry.entryType === 'command' && entry.command) {
                // Apply command to KV store
                result = this.applyCommand(entry.command);
                logger.debug(`Applied command: ${entry.command.type} ${entry.command.key} -> ${result}`);
            } else if (entry.entryType === 'config' && entry.configChange) {
                // Apply configuration change
                this.applyConfigChange(entry.configChange);
                result = 'OK';
            }
            // 'noop' entries don't need any action

            // Update lastApplied
            this.state.volatile.lastApplied = indexToApply;

            // Resolve pending command if this is the leader
            const pending = this.pendingCommands.get(indexToApply);
            if (pending) {
                // Clear timeout
                if ((pending as any).timeoutId) {
                    clearTimeout((pending as any).timeoutId);
                }
                pending.resolve(result);
                this.pendingCommands.delete(indexToApply);
            }
        }
    }

    /**
     * Apply a command to the KV store (Person 3)
     * 
     * @param command - Command to apply
     * @returns Result of the command
     */
    private applyCommand(command: Command): string {
        switch (command.type) {
            case 'set':
                this.kvStore.set(command.key, command.value || '');
                return 'OK';
            case 'del':
                return `"${this.kvStore.del(command.key)}"`;
            case 'append':
                this.kvStore.append(command.key, command.value || '');
                return 'OK';
            default:
                return 'ERROR: Unknown command';
        }
    }

    /**
     * Apply a configuration change (Person 3)
     * 
     * This is called when a config entry is committed (by both leaders and followers).
     * If the change removes THIS node, we should shut down.
     * 
     * @param configChange - Configuration change to apply
     */
    private applyConfigChange(configChange: ConfigChange): void {
        if (configChange.type === 'add_server') {
            // Check if already exists
            const existing = this.state.clusterConfig.find(s => s.id === configChange.server.id);
            if (!existing) {
                this.state.clusterConfig.push(configChange.server);
                logger.info(`Config applied: Added server ${configChange.server.id}`);
            }
        } else if (configChange.type === 'remove_server') {
            const serverId = configChange.server.id;
            const idx = this.state.clusterConfig.findIndex(s => s.id === serverId);

            if (idx !== -1) {
                // IMPORTANT: If we're the leader and removing a DIFFERENT node,
                // we need to notify that node BEFORE removing it from our config.
                // Otherwise, replicateToAllFollowers won't include the removed node.
                if (this.state.nodeState === NodeState.LEADER && serverId !== this.config.nodeId) {
                    logger.info(`Sending commit notification to ${serverId} before removing from config...`);
                    // Send multiple heartbeats to ensure the removed node receives the commit
                    this.replicateToAllFollowers();
                    setTimeout(() => {
                        if (this.state.nodeState === NodeState.LEADER) {
                            this.replicateToAllFollowersIncluding(serverId);
                        }
                    }, 50);
                    setTimeout(() => {
                        if (this.state.nodeState === NodeState.LEADER) {
                            this.replicateToAllFollowersIncluding(serverId);
                        }
                    }, 100);
                    setTimeout(() => {
                        if (this.state.nodeState === NodeState.LEADER) {
                            this.replicateToAllFollowersIncluding(serverId);
                        }
                    }, 150);
                }

                // Now remove from cluster config
                this.state.clusterConfig.splice(idx, 1);
                logger.info(`Config applied: Removed server ${serverId}`);

                // Clean up leader state for removed server
                if (this.state.leaderState) {
                    this.state.leaderState.nextIndex.delete(serverId);
                    this.state.leaderState.matchIndex.delete(serverId);
                }

                // If WE were removed, shut down this node
                // This handles both leader and follower cases
                if (serverId === this.config.nodeId) {
                    logger.info('This node was removed from cluster, shutting down...');

                    // If we're the leader, send heartbeats to propagate the commit before shutting down
                    // This ensures all followers receive the updated leaderCommit
                    if (this.state.nodeState === NodeState.LEADER) {
                        logger.info('Propagating commit to followers before shutdown...');
                        // Send multiple heartbeats to ensure propagation
                        this.replicateToAllFollowers();
                        setTimeout(() => {
                            if (this.state.nodeState === NodeState.LEADER) {
                                this.replicateToAllFollowers();
                            }
                        }, 100);
                        setTimeout(() => {
                            if (this.state.nodeState === NodeState.LEADER) {
                                this.replicateToAllFollowers();
                            }
                        }, 200);
                        setTimeout(() => {
                            if (this.state.nodeState === NodeState.LEADER) {
                                this.replicateToAllFollowers();
                            }
                        }, 300);
                    }

                    // Transition to follower after a delay to allow heartbeats to be sent
                    setTimeout(() => {
                        this.transitionTo(NodeState.FOLLOWER, 'removed from cluster');
                    }, 500);

                    // Longer delay to allow commit propagation and response to be sent
                    setTimeout(() => this.stop(), 2000);
                }
            }
        }
    }

    /**
     * Replicate to all followers INCLUDING a specific node that may have been removed
     * This is used to send commit notifications to nodes being removed
     */
    private replicateToAllFollowersIncluding(nodeId: string): void {
        if (this.state.nodeState !== NodeState.LEADER) {
            return;
        }

        // Find the node info - it might have been removed from clusterConfig
        let nodeToReplicate: ServerInfo | undefined = this.state.clusterConfig.find(s => s.id === nodeId);

        // If not in clusterConfig, try to reconstruct it (assume hostname = nodeId, port = 3000)
        if (!nodeToReplicate) {
            nodeToReplicate = { id: nodeId, address: nodeId, port: 3000 };
        }

        // Replicate to this specific node
        this.replicateToFollower(nodeToReplicate);

        // Also replicate to all current followers
        this.replicateToAllFollowers();
    }

    // ============================================================================
    // Membership Changes (Person 1 + Person 3 Integration)
    // ============================================================================

    /**
     * Add a new server to the cluster (with Log Replication)
     * 
     * This implements the membership change protocol:
     * 1. Create config change log entry
     * 2. Replicate to followers
     * 3. Wait for commit (majority acknowledgment)
     * 4. Apply config change (adding to cluster)
     * 5. Return success
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

        // Update our own matchIndex (leader always matches itself)
        if (this.state.leaderState) {
            this.state.leaderState.matchIndex.set(this.config.nodeId, entry.index);

            // Initialize leader state for new server (before replication)
            // This allows us to start replicating to the new server immediately
            this.state.leaderState.nextIndex.set(newServer.id, entry.index + 1);
            this.state.leaderState.matchIndex.set(newServer.id, 0);
        }

        // Wait for the config change to be committed
        return new Promise<AddServerResponse>((resolve) => {
            // Store pending config change
            this.pendingCommands.set(entry.index, {
                resolve: () => {
                    logger.info(`Server ${newServer.id} added to cluster. New cluster size: ${this.state.clusterConfig.length}`);
                    resolve({
                        success: true,
                        leaderId: this.config.nodeId,
                    });
                },
                reject: (error: Error) => {
                    logger.error(`Failed to add server ${newServer.id}: ${error.message}`);
                    resolve({
                        success: false,
                        leaderId: this.config.nodeId,
                        error: error.message,
                    });
                },
                command: { type: 'set', key: '__config__', value: 'add_server' }, // Dummy command for typing
            });

            // Set timeout for config change
            const timeoutId = setTimeout(() => {
                if (this.pendingCommands.has(entry.index)) {
                    this.pendingCommands.delete(entry.index);
                    logger.error(`Timeout adding server ${newServer.id}`);
                    resolve({
                        success: false,
                        leaderId: this.config.nodeId,
                        error: 'Timeout waiting for commit',
                    });
                }
            }, RaftNode.COMMAND_TIMEOUT);

            const pending = this.pendingCommands.get(entry.index);
            if (pending) {
                (pending as any).timeoutId = timeoutId;
            }

            // Trigger immediate replication
            this.replicateToAllFollowers();
        });
    }

    /**
     * Remove a server from the cluster (with Log Replication)
     * 
     * This implements the membership change protocol:
     * 1. Create config change log entry
     * 2. Replicate to followers
     * 3. Wait for commit (majority acknowledgment)
     * 4. Apply config change (removing from cluster)
     * 5. Return success
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

        // Update our own matchIndex (leader always matches itself)
        if (this.state.leaderState) {
            this.state.leaderState.matchIndex.set(this.config.nodeId, entry.index);
        }

        // Wait for the config change to be committed
        return new Promise<RemoveServerResponse>((resolve) => {
            // Store pending config change
            this.pendingCommands.set(entry.index, {
                resolve: () => {
                    logger.info(`Server ${serverId} removed from cluster. New cluster size: ${this.state.clusterConfig.length}`);
                    // Note: If this node was removed, applyConfigChange handles the shutdown
                    resolve({
                        success: true,
                        leaderId: this.config.nodeId,
                    });
                },
                reject: (error: Error) => {
                    logger.error(`Failed to remove server ${serverId}: ${error.message}`);
                    resolve({
                        success: false,
                        leaderId: this.config.nodeId,
                        error: error.message,
                    });
                },
                command: { type: 'set', key: '__config__', value: 'remove_server' }, // Dummy command for typing
            });

            // Set timeout for config change
            const timeoutId = setTimeout(() => {
                if (this.pendingCommands.has(entry.index)) {
                    this.pendingCommands.delete(entry.index);
                    logger.error(`Timeout removing server ${serverId}`);
                    resolve({
                        success: false,
                        leaderId: this.config.nodeId,
                        error: 'Timeout waiting for commit',
                    });
                }
            }, RaftNode.COMMAND_TIMEOUT);

            const pending = this.pendingCommands.get(entry.index);
            if (pending) {
                (pending as any).timeoutId = timeoutId;
            }

            // Trigger immediate replication
            this.replicateToAllFollowers();
        });
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
