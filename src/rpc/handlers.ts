/**
 * RPC Handlers Module, provides the RPC method handlers that connect incoming RPC requests
 * to the Raft node logic. 
 * 
 * @module rpc/handlers
 */

import { RpcHandler, notLeaderError, rpcError } from './server';
import {
    RPC_METHODS,
    RPC_ERROR_CODES,
    RequestVoteRequest,
    RequestVoteResponse,
    AppendEntriesRequest,
    AppendEntriesResponse,
    ExecuteRequest,
    ExecuteResponse,
    RequestLogRequest,
    RequestLogResponse,
    AddServerRequest,
    AddServerResponse,
    RemoveServerRequest,
    RemoveServerResponse,
} from './types';
import { NodeState } from '../raft/types';
import { Logger } from '../utils/logger';

const logger = new Logger('RPC-Handlers');

/**
 * Interface for the Raft Node that handlers interact 
 */
export interface IRaftNode {
    // State getters
    getNodeId(): string;
    getNodeState(): NodeState;
    getCurrentTerm(): number;
    getLeaderId(): string | null;
    getLeaderAddress(): string | null;

    // For Person 2: Leader Election
    handleRequestVote(request: RequestVoteRequest): Promise<RequestVoteResponse>;

    // For Person 3: Log Replication
    handleAppendEntries(request: AppendEntriesRequest): Promise<AppendEntriesResponse>;

    // For Person 3: Client commands
    executeCommand(command: string, args: string[]): Promise<string>;
    getLog(): any[];

    // For Person 1: Membership changes
    handleAddServer(request: AddServerRequest): Promise<AddServerResponse>;
    handleRemoveServer(request: RemoveServerRequest): Promise<RemoveServerResponse>;
}

/**
 * Create RPC handlers for a Raft node
 * 
 * @param node - The Raft node instance
 * @returns Record of method names to handler functions
 */
export function createRpcHandlers(node: IRaftNode): Record<string, RpcHandler> {
    /**
     * Check if this node is the leader, throw error if not
     */
    function requireLeader(): void {
        if (node.getNodeState() !== NodeState.LEADER) {
            throw notLeaderError(node.getLeaderId(), node.getLeaderAddress());
        }
    }

    return {
        /**
         * RequestVote RPC handler (Person 2 implements the actual logic)
         * 
         * Called by candidates during leader election to request votes.
         */
        [RPC_METHODS.REQUEST_VOTE]: async (params: RequestVoteRequest): Promise<RequestVoteResponse> => {
            logger.info(`RequestVote from ${params.candidateId} for term ${params.term}`);

            // Validate required parameters
            if (typeof params.term !== 'number' ||
                typeof params.candidateId !== 'string' ||
                typeof params.lastLogIndex !== 'number' ||
                typeof params.lastLogTerm !== 'number') {
                throw rpcError(RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid RequestVote parameters');
            }

            // Delegate to Raft node (Person 2's implementation)
            const response = await node.handleRequestVote(params);

            logger.info(`RequestVote response: voteGranted=${response.voteGranted}, term=${response.term}`);
            return response;
        },

        /**
         * AppendEntries RPC handler (Person 3 implements the actual logic)
         * 
         * Called by leader to replicate log entries and as heartbeat.
         */
        [RPC_METHODS.APPEND_ENTRIES]: async (params: AppendEntriesRequest): Promise<AppendEntriesResponse> => {
            logger.debug(`AppendEntries from ${params.leaderId}, term=${params.term}, entries=${params.entries?.length || 0}`);

            // Validate required parameters
            if (typeof params.term !== 'number' ||
                typeof params.leaderId !== 'string' ||
                typeof params.prevLogIndex !== 'number' ||
                typeof params.prevLogTerm !== 'number' ||
                typeof params.leaderCommit !== 'number') {
                throw rpcError(RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid AppendEntries parameters');
            }

            // Ensure entries is an array
            if (!Array.isArray(params.entries)) {
                params.entries = [];
            }

            // Delegate to Raft node (Person 3's implementation)
            const response = await node.handleAppendEntries(params);

            logger.debug(`AppendEntries response: success=${response.success}, term=${response.term}`);
            return response;
        },

        /**
         * Execute RPC handler (Person 1 - routing, Person 3 - actual execution)
         * 
         * Executes a client command (ping, get, set, strln, del, append).
         * Only the leader can execute commands.
         */
        [RPC_METHODS.EXECUTE]: async (params: ExecuteRequest): Promise<ExecuteResponse> => {
            logger.info(`Execute command: ${params.command} ${params.args?.join(' ') || ''}`);

            // Validate parameters
            if (typeof params.command !== 'string') {
                throw rpcError(RPC_ERROR_CODES.INVALID_PARAMS, 'Command must be a string');
            }

            const command = params.command.toLowerCase();
            const args = params.args || [];

            // Ping is a special case - doesn't require leader
            // But according to spec, all client requests go to leader
            // So we still require leader for consistency

            // Check if this is a read-only command (doesn't modify state)
            const readOnlyCommands = ['get'];
            const isReadOnly = readOnlyCommands.includes(command);

            // For now, all commands require leader (can optimize reads later)
            // Check if we're the leader
            if (node.getNodeState() !== NodeState.LEADER && !isReadOnly) {
                return {
                    success: false,
                    result: '',
                    leaderId: node.getLeaderId(),
                    leaderAddress: node.getLeaderAddress() || undefined,
                };
            }

            try {
                // Execute the command (delegated to Person 3's implementation)
                const result = await node.executeCommand(command, args);

                return {
                    success: true,
                    result,
                    leaderId: node.getNodeId(),
                };
            } catch (error) {
                logger.error(`Execute command failed:`, (error as Error).message);
                return {
                    success: false,
                    result: (error as Error).message,
                    leaderId: node.getLeaderId(),
                };
            }
        },

        /**
         * RequestLog RPC handler (Person 1)
         * 
         * Returns the leader's log entries.
         * Only the leader can respond to this.
         */
        [RPC_METHODS.REQUEST_LOG]: async (params: RequestLogRequest): Promise<RequestLogResponse> => {
            logger.info('RequestLog received');

            // Check if we're the leader
            if (node.getNodeState() !== NodeState.LEADER) {
                return {
                    success: false,
                    log: [],
                    leaderId: node.getLeaderId(),
                    leaderAddress: node.getLeaderAddress() || undefined,
                    error: 'Not the leader',
                };
            }

            try {
                const log = node.getLog();

                return {
                    success: true,
                    log,
                    leaderId: node.getNodeId(),
                };
            } catch (error) {
                logger.error('RequestLog failed:', (error as Error).message);
                return {
                    success: false,
                    log: [],
                    leaderId: node.getLeaderId(),
                    error: (error as Error).message,
                };
            }
        },

        /**
         * AddServer RPC handler (Person 1)
         * 
         * Adds a new server to the cluster.
         * Only the leader can process membership changes.
         */
        [RPC_METHODS.ADD_SERVER]: async (params: AddServerRequest): Promise<AddServerResponse> => {
            logger.info(`AddServer requested for: ${params.newServer?.id}`);

            // Validate parameters
            if (!params.newServer ||
                typeof params.newServer.id !== 'string' ||
                typeof params.newServer.address !== 'string' ||
                typeof params.newServer.port !== 'number') {
                throw rpcError(RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid server info');
            }

            // Check if we're the leader
            if (node.getNodeState() !== NodeState.LEADER) {
                return {
                    success: false,
                    leaderId: node.getLeaderId(),
                    error: 'Not the leader',
                };
            }

            // Delegate to membership logic
            return node.handleAddServer(params);
        },

        /**
         * RemoveServer RPC handler (Person 1)
         * 
         * Removes a server from the cluster.
         * Only the leader can process membership changes.
         */
        [RPC_METHODS.REMOVE_SERVER]: async (params: RemoveServerRequest): Promise<RemoveServerResponse> => {
            logger.info(`RemoveServer requested for: ${params.serverId}`);

            // Validate parameters
            if (typeof params.serverId !== 'string') {
                throw rpcError(RPC_ERROR_CODES.INVALID_PARAMS, 'Server ID must be a string');
            }

            // Check if we're the leader
            if (node.getNodeState() !== NodeState.LEADER) {
                return {
                    success: false,
                    leaderId: node.getLeaderId(),
                    error: 'Not the leader',
                };
            }

            // Delegate to membership logic
            return node.handleRemoveServer(params);
        },
    };
}
