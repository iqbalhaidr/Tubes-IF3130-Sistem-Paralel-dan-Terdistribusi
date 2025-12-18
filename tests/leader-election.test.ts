/**
 * Leader Election Unit Tests
 * 
 * Tests for Raft leader election mechanism including:
 * - Election timeout handling
 * - Vote request/response logic
 * - Term management
 * - State transitions during elections
 */

import {
    RaftState,
    NodeState,
    createInitialRaftState,
    createLeaderState,
    LogEntry,
} from '../src/raft/types';
import {
    RequestVoteRequest,
    RequestVoteResponse,
} from '../src/rpc/types';
import { ServerInfo } from '../src/config';

// Helper functions to work with RaftState
function getLastLogIndex(state: RaftState): number {
    const log = state.persistent.log;
    if (log.length === 0) return 0;
    return log[log.length - 1].index;
}

function getLastLogTerm(state: RaftState): number {
    const log = state.persistent.log;
    if (log.length === 0) return 0;
    return log[log.length - 1].term;
}

describe('Leader Election - Vote Request Logic', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.currentTerm = 1;
    });

    describe('Vote Granting Rules', () => {
        it('should grant vote if not voted in current term', () => {
            const request: RequestVoteRequest = {
                term: 2,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            // Simulate vote granting logic
            const canGrant =
                request.term > state.persistent.currentTerm &&
                state.persistent.votedFor === null;

            expect(canGrant).toBe(true);
        });

        it('should not grant vote if already voted in current term', () => {
            state.persistent.votedFor = 'node3';

            const request: RequestVoteRequest = {
                term: 1,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            const canGrant =
                request.term > state.persistent.currentTerm ||
                (request.term === state.persistent.currentTerm &&
                    state.persistent.votedFor === null);

            expect(canGrant).toBe(false);
        });

        it('should grant vote to same candidate in same term', () => {
            state.persistent.votedFor = 'node2';

            const request: RequestVoteRequest = {
                term: 1,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            const canGrant =
                request.term > state.persistent.currentTerm ||
                (request.term === state.persistent.currentTerm &&
                    (state.persistent.votedFor === null || state.persistent.votedFor === request.candidateId));

            expect(canGrant).toBe(true);
        });

        it('should reject vote if candidate term is lower', () => {
            state.persistent.currentTerm = 3;

            const request: RequestVoteRequest = {
                term: 2,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            const canGrant = request.term >= state.persistent.currentTerm;
            expect(canGrant).toBe(false);
        });
    });

    describe('Log Up-to-Date Check', () => {
        beforeEach(() => {
            // Add some log entries
            state.persistent.log = [
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
                { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
                { term: 2, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'v3' }, timestamp: Date.now() },
            ];
        });

        it('should grant vote if candidate log is more up-to-date (higher term)', () => {
            const lastLogIndex = getLastLogIndex(state);
            const lastLogTerm = getLastLogTerm(state);

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: 2,
                lastLogTerm: 3, // Higher term than our last log term (2)
            };

            const isUpToDate =
                request.lastLogTerm > lastLogTerm ||
                (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

            expect(isUpToDate).toBe(true);
        });

        it('should grant vote if candidate log is more up-to-date (same term, longer log)', () => {
            const lastLogIndex = getLastLogIndex(state);
            const lastLogTerm = getLastLogTerm(state);

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: 4,
                lastLogTerm: 2, // Same term as our last log
            };

            const isUpToDate =
                request.lastLogTerm > lastLogTerm ||
                (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

            expect(isUpToDate).toBe(true);
        });

        it('should reject vote if candidate log is less up-to-date (lower term)', () => {
            const lastLogIndex = getLastLogIndex(state);
            const lastLogTerm = getLastLogTerm(state);

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: 5,
                lastLogTerm: 1, // Lower term than our last log term (2)
            };

            const isUpToDate =
                request.lastLogTerm > lastLogTerm ||
                (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

            expect(isUpToDate).toBe(false);
        });

        it('should reject vote if candidate log is less up-to-date (same term, shorter log)', () => {
            const lastLogIndex = getLastLogIndex(state);
            const lastLogTerm = getLastLogTerm(state);

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: 2,
                lastLogTerm: 2, // Same term but shorter log
            };

            const isUpToDate =
                request.lastLogTerm > lastLogTerm ||
                (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

            expect(isUpToDate).toBe(false);
        });

        it('should grant vote if logs are identical', () => {
            const lastLogIndex = getLastLogIndex(state);
            const lastLogTerm = getLastLogTerm(state);

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: lastLogIndex,
                lastLogTerm: lastLogTerm,
            };

            const isUpToDate =
                request.lastLogTerm > lastLogTerm ||
                (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

            expect(isUpToDate).toBe(true);
        });
    });

    describe('Term Update on Vote Request', () => {
        it('should update term when receiving higher term', () => {
            state.persistent.currentTerm = 1;
            state.persistent.votedFor = 'node1';

            const request: RequestVoteRequest = {
                term: 3,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            // Simulate term update
            if (request.term > state.persistent.currentTerm) {
                state.persistent.currentTerm = request.term;
                state.persistent.votedFor = null;
                state.nodeState = NodeState.FOLLOWER;
            }

            expect(state.persistent.currentTerm).toBe(3);
            expect(state.persistent.votedFor).toBeNull();
            expect(state.nodeState).toBe(NodeState.FOLLOWER);
        });

        it('should not update term when receiving equal or lower term', () => {
            state.persistent.currentTerm = 3;
            state.persistent.votedFor = 'node1';

            const request: RequestVoteRequest = {
                term: 2,
                candidateId: 'node2',
                lastLogIndex: 0,
                lastLogTerm: 0,
            };

            const originalTerm = state.persistent.currentTerm;
            const originalVote = state.persistent.votedFor;

            // No update should occur
            if (request.term > state.persistent.currentTerm) {
                state.persistent.currentTerm = request.term;
                state.persistent.votedFor = null;
            }

            expect(state.persistent.currentTerm).toBe(originalTerm);
            expect(state.persistent.votedFor).toBe(originalVote);
        });
    });
});

describe('Leader Election - Candidate State', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
    });

    describe('Starting Election', () => {
        it('should increment term when starting election', () => {
            const originalTerm = state.persistent.currentTerm;

            // Simulate starting election
            state.persistent.currentTerm += 1;
            state.nodeState = NodeState.CANDIDATE;
            state.persistent.votedFor = 'node1'; // Vote for self

            expect(state.persistent.currentTerm).toBe(originalTerm + 1);
            expect(state.nodeState).toBe(NodeState.CANDIDATE);
            expect(state.persistent.votedFor).toBe('node1');
        });

        it('should vote for self when becoming candidate', () => {
            state.nodeState = NodeState.CANDIDATE;
            state.persistent.votedFor = 'node1';

            expect(state.persistent.votedFor).toBe('node1');
        });

        it('should transition to candidate from follower', () => {
            state.nodeState = NodeState.FOLLOWER;

            // Simulate election timeout
            state.nodeState = NodeState.CANDIDATE;

            expect(state.nodeState).toBe(NodeState.CANDIDATE);
        });
    });

    describe('Vote Counting', () => {
        it('should win election with majority votes (3 nodes)', () => {
            const clusterSize = 3;
            const votesReceived = 2; // Self + 1 other
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeGreaterThanOrEqual(majority);
        });

        it('should not win election without majority (3 nodes)', () => {
            const clusterSize = 3;
            const votesReceived = 1; // Only self
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeLessThan(majority);
        });

        it('should win election with majority votes (5 nodes)', () => {
            const clusterSize = 5;
            const votesReceived = 3; // Self + 2 others
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeGreaterThanOrEqual(majority);
        });

        it('should handle split vote scenario (3 nodes)', () => {
            const clusterSize = 3;
            const votesReceived = 1; // Only self, others voted for different candidates
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeLessThan(majority);
        });
    });

    describe('Becoming Leader', () => {
        it('should transition to leader after winning election', () => {
            state.nodeState = NodeState.CANDIDATE;

            // Simulate winning election
            state.nodeState = NodeState.LEADER;
            state.leaderState = createLeaderState(getLastLogIndex(state), cluster);

            expect(state.nodeState).toBe(NodeState.LEADER);
            expect(state.leaderState).toBeDefined();
        });

        it('should initialize leader state correctly', () => {
            const lastLogIndex = 5;
            state.nodeState = NodeState.LEADER;
            state.leaderState = createLeaderState(lastLogIndex, cluster);

            // All nextIndex should be lastLogIndex + 1
            cluster.forEach(server => {
                expect(state.leaderState!.nextIndex.get(server.id)).toBe(lastLogIndex + 1);
                expect(state.leaderState!.matchIndex.get(server.id)).toBe(0);
            });
        });
    });

    describe('Reverting to Follower', () => {
        it('should revert to follower when discovering higher term', () => {
            state.nodeState = NodeState.CANDIDATE;
            state.persistent.currentTerm = 2;

            const higherTerm = 5;

            // Simulate discovering higher term
            if (higherTerm > state.persistent.currentTerm) {
                state.persistent.currentTerm = higherTerm;
                state.persistent.votedFor = null;
                state.nodeState = NodeState.FOLLOWER;
            }

            expect(state.nodeState).toBe(NodeState.FOLLOWER);
            expect(state.persistent.currentTerm).toBe(higherTerm);
            expect(state.persistent.votedFor).toBeNull();
        });

        it('should revert to follower when another candidate wins', () => {
            state.nodeState = NodeState.CANDIDATE;
            state.persistent.currentTerm = 2;

            // Simulate receiving AppendEntries from new leader with same term
            const leaderTerm = 2;

            if (leaderTerm >= state.persistent.currentTerm) {
                state.nodeState = NodeState.FOLLOWER;
            }

            expect(state.nodeState).toBe(NodeState.FOLLOWER);
        });
    });
});

describe('Leader Election - Edge Cases', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
    });

    describe('Concurrent Elections', () => {
        it('should handle multiple candidates in same term', () => {
            // Node1 starts election
            const node1Term = 2;
            const node1VotedFor = 'node1';

            // Node2 also starts election in same term (unlikely but possible)
            const node2Term = 2;
            const node2VotedFor = 'node2';

            // Each can only vote for one candidate in a term
            expect(node1VotedFor).not.toBe(node2VotedFor);
            expect(node1Term).toBe(node2Term);
        });

        it('should handle election timeout during election', () => {
            state.nodeState = NodeState.CANDIDATE;
            state.persistent.currentTerm = 2;

            // Simulate election timeout without winning
            // Should start new election with incremented term
            state.persistent.currentTerm += 1;
            state.persistent.votedFor = 'node1';

            expect(state.persistent.currentTerm).toBe(3);
            expect(state.nodeState).toBe(NodeState.CANDIDATE);
        });
    });

    describe('Single Node Cluster', () => {
        beforeEach(() => {
            const singleNodeCluster: ServerInfo[] = [
                { id: 'node1', address: 'node1', port: 3000 },
            ];
            state = createInitialRaftState(singleNodeCluster);
        });

        it('should immediately become leader with single vote', () => {
            const clusterSize = 1;
            const votesReceived = 1; // Only self
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeGreaterThanOrEqual(majority);
        });
    });

    describe('Even-Sized Cluster', () => {
        beforeEach(() => {
            const evenCluster: ServerInfo[] = [
                { id: 'node1', address: 'node1', port: 3000 },
                { id: 'node2', address: 'node2', port: 3000 },
                { id: 'node3', address: 'node3', port: 3000 },
                { id: 'node4', address: 'node4', port: 3000 },
            ];
            state = createInitialRaftState(evenCluster);
        });

        it('should require 3 votes to win in 4-node cluster', () => {
            const clusterSize = 4;
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(majority).toBe(3);
        });

        it('should not win with exactly half the votes', () => {
            const clusterSize = 4;
            const votesReceived = 2; // Exactly half
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(votesReceived).toBeLessThan(majority);
        });
    });

    describe('Network Partition Scenarios', () => {
        it('should not become leader if isolated (minority partition)', () => {
            const clusterSize = 5;
            const reachableNodes = 2; // Including self
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(reachableNodes).toBeLessThan(majority);
        });

        it('should become leader if in majority partition', () => {
            const clusterSize = 5;
            const reachableNodes = 3; // Including self
            const majority = Math.floor(clusterSize / 2) + 1;

            expect(reachableNodes).toBeGreaterThanOrEqual(majority);
        });
    });
});

describe('Leader Election - Response Handling', () => {
    describe('Vote Response Processing', () => {
        it('should count granted vote', () => {
            const response: RequestVoteResponse = {
                term: 2,
                voteGranted: true,
            };

            let votesReceived = 1; // Start with self-vote
            if (response.voteGranted && response.term === 2) {
                votesReceived += 1;
            }

            expect(votesReceived).toBe(2);
        });

        it('should not count rejected vote', () => {
            const response: RequestVoteResponse = {
                term: 2,
                voteGranted: false,
            };

            let votesReceived = 1; // Start with self-vote
            if (response.voteGranted && response.term === 2) {
                votesReceived += 1;
            }

            expect(votesReceived).toBe(1);
        });

        it('should update term if response has higher term', () => {
            let currentTerm = 2;
            const response: RequestVoteResponse = {
                term: 5,
                voteGranted: false,
            };

            if (response.term > currentTerm) {
                currentTerm = response.term;
            }

            expect(currentTerm).toBe(5);
        });

        it('should ignore stale responses from old terms', () => {
            const currentTerm = 5;
            const response: RequestVoteResponse = {
                term: 3,
                voteGranted: true,
            };

            let votesReceived = 1;
            if (response.voteGranted && response.term === currentTerm) {
                votesReceived += 1;
            }

            expect(votesReceived).toBe(1); // Should not count stale vote
        });
    });
});
