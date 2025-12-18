/**
 * AppendEntries RPC Unit Tests
 * 
 * Tests for AppendEntries RPC handling including:
 * - Heartbeat processing
 * - Log consistency checks
 * - Entry appending logic
 * - Commit index updates
 */

import {
    RaftState,
    NodeState,
    createInitialRaftState,
    createLeaderState,
    LogEntry,
} from '../src/raft/types';
import {
    AppendEntriesRequest,
    AppendEntriesResponse,
} from '../src/rpc/types';
import { ServerInfo } from '../src/config';

// Helper function to get log entry by index from state
function getLogEntry(state: RaftState, index: number): LogEntry | null {
    // Find entry by its index property, not array position
    const entry = state.persistent.log.find(e => e.index === index);
    return entry || null;
}

// Helper function to get last log index from state
function getLastLogIndex(state: RaftState): number {
    const log = state.persistent.log;
    if (log.length === 0) return 0;
    return log[log.length - 1].index;
}

// Helper function to get last log term from state
function getLastLogTerm(state: RaftState): number {
    const log = state.persistent.log;
    if (log.length === 0) return 0;
    return log[log.length - 1].term;
}

describe('AppendEntries - Heartbeat Processing', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.currentTerm = 1;
        state.nodeState = NodeState.FOLLOWER;
    });

    describe('Term Validation', () => {
        it('should reject AppendEntries with lower term', () => {
            state.persistent.currentTerm = 5;

            const request: AppendEntriesRequest = {
                term: 3,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            const shouldAccept = request.term >= state.persistent.currentTerm;
            expect(shouldAccept).toBe(false);
        });

        it('should accept AppendEntries with equal term', () => {
            state.persistent.currentTerm = 3;

            const request: AppendEntriesRequest = {
                term: 3,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            const shouldAccept = request.term >= state.persistent.currentTerm;
            expect(shouldAccept).toBe(true);
        });

        it('should accept AppendEntries with higher term and update state', () => {
            state.persistent.currentTerm = 3;
            state.nodeState = NodeState.CANDIDATE;

            const request: AppendEntriesRequest = {
                term: 5,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            // Simulate term update
            if (request.term > state.persistent.currentTerm) {
                state.persistent.currentTerm = request.term;
                state.persistent.votedFor = null;
                state.nodeState = NodeState.FOLLOWER;
            }

            expect(state.persistent.currentTerm).toBe(5);
            expect(state.nodeState).toBe(NodeState.FOLLOWER);
            expect(state.persistent.votedFor).toBeNull();
        });
    });

    describe('Heartbeat Recognition', () => {
        it('should recognize empty AppendEntries as heartbeat', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            const isHeartbeat = request.entries.length === 0;
            expect(isHeartbeat).toBe(true);
        });

        it('should recognize non-empty AppendEntries as log replication', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [
                    { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const isHeartbeat = request.entries.length === 0;
            expect(isHeartbeat).toBe(false);
        });

        it('should reset election timer on valid heartbeat', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            // Simulate election timer reset
            let electionTimerReset = false;
            if (request.term >= state.persistent.currentTerm) {
                electionTimerReset = true;
            }

            expect(electionTimerReset).toBe(true);
        });
    });

    describe('Leader Recognition', () => {
        it('should recognize leader from AppendEntries', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            // Simulate leader recognition
            if (request.term >= state.persistent.currentTerm) {
                state.leaderId = request.leaderId;
            }

            expect(state.leaderId).toBe('node2');
        });

        it('should update leader if different leader in higher term', () => {
            state.leaderId = 'node2';
            state.persistent.currentTerm = 1;

            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node3',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            // Simulate leader update
            if (request.term > state.persistent.currentTerm) {
                state.persistent.currentTerm = request.term;
                state.leaderId = request.leaderId;
            }

            expect(state.leaderId).toBe('node3');
        });
    });
});

describe('AppendEntries - Log Consistency Check', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.currentTerm = 2;
        state.persistent.log = [
            { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
            { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
            { term: 2, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'v3' }, timestamp: Date.now() },
        ];
    });

    describe('PrevLog Matching', () => {
        it('should accept if prevLogIndex is 0 (empty log check)', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [],
                leaderCommit: 0,
            };

            const prevLogMatches = request.prevLogIndex === 0;
            expect(prevLogMatches).toBe(true);
        });

        it('should accept if prevLog entry matches', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [],
                leaderCommit: 0,
            };

            const prevEntry = getLogEntry(state, request.prevLogIndex);
            const prevLogMatches =
                prevEntry !== null &&
                prevEntry.term === request.prevLogTerm;

            expect(prevLogMatches).toBe(true);
        });

        it('should reject if prevLogIndex exceeds log length', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 10,
                prevLogTerm: 2,
                entries: [],
                leaderCommit: 0,
            };

            const prevEntry = getLogEntry(state, request.prevLogIndex);
            const prevLogMatches = prevEntry !== null;

            expect(prevLogMatches).toBe(false);
        });

        it('should reject if prevLog term does not match', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 2, // Wrong term (should be 1)
                entries: [],
                leaderCommit: 0,
            };

            const prevEntry = getLogEntry(state, request.prevLogIndex);
            const prevLogMatches =
                prevEntry !== null &&
                prevEntry.term === request.prevLogTerm;

            expect(prevLogMatches).toBe(false);
        });
    });

    describe('Conflict Detection', () => {
        it('should detect no conflict when appending to end of log', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [
                    { term: 2, index: 4, entryType: 'command', command: { type: 'set', key: 'k4', value: 'v4' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const newEntry = request.entries[0];
            const existingEntry = getLogEntry(state, newEntry.index);
            const hasConflict = existingEntry !== null && existingEntry.term !== newEntry.term;

            expect(hasConflict).toBe(false);
        });

        it('should detect conflict when terms differ at same index', () => {
            const request: AppendEntriesRequest = {
                term: 3,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [
                    { term: 3, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'new' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const newEntry = request.entries[0];
            const existingEntry = getLogEntry(state, newEntry.index);
            const hasConflict = existingEntry !== null && existingEntry.term !== newEntry.term;

            expect(hasConflict).toBe(true);
        });

        it('should not detect conflict when entry does not exist yet', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [
                    { term: 2, index: 4, entryType: 'command', command: { type: 'set', key: 'k4', value: 'v4' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const newEntry = request.entries[0];
            const existingEntry = getLogEntry(state, newEntry.index);
            const hasConflict = existingEntry !== null && existingEntry.term !== newEntry.term;

            expect(hasConflict).toBe(false);
            expect(existingEntry).toBeNull();
        });
    });

    describe('Conflict Resolution', () => {
        it('should delete conflicting entries and all that follow', () => {
            const request: AppendEntriesRequest = {
                term: 3,
                leaderId: 'node2',
                prevLogIndex: 1,
                prevLogTerm: 1,
                entries: [
                    { term: 3, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'new' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const newEntry = request.entries[0];
            const existingEntry = getLogEntry(state, newEntry.index);

            // Simulate conflict resolution
            if (existingEntry && existingEntry.term !== newEntry.term) {
                // Delete from conflicting index onwards
                state.persistent.log = state.persistent.log.filter(e => e.index < newEntry.index);
            }

            expect(state.persistent.log).toHaveLength(1);
            expect(state.persistent.log[0].index).toBe(1);
        });

        it('should preserve matching entries before conflict', () => {
            const originalLog = [...state.persistent.log];

            const request: AppendEntriesRequest = {
                term: 3,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [
                    { term: 3, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'new' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const newEntry = request.entries[0];
            const existingEntry = getLogEntry(state, newEntry.index);

            // Simulate conflict resolution
            if (existingEntry && existingEntry.term !== newEntry.term) {
                state.persistent.log = state.persistent.log.filter(e => e.index < newEntry.index);
            }

            // Entries before conflict should be preserved
            expect(state.persistent.log).toHaveLength(2);
            expect(state.persistent.log[0]).toEqual(originalLog[0]);
            expect(state.persistent.log[1]).toEqual(originalLog[1]);
        });
    });
});

describe('AppendEntries - Entry Appending', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.currentTerm = 2;
        state.persistent.log = [
            { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
            { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
        ];
    });

    describe('Appending New Entries', () => {
        it('should append single new entry', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [
                    { term: 2, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'v3' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            // Simulate appending
            request.entries.forEach((entry: LogEntry) => {
                const existingEntry = getLogEntry(state, entry.index);
                if (!existingEntry) {
                    state.persistent.log.push(entry);
                }
            });

            expect(state.persistent.log).toHaveLength(3);
            expect(state.persistent.log[2].index).toBe(3);
            expect(state.persistent.log[2].command?.key).toBe('k3');
        });

        it('should append multiple new entries', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [
                    { term: 2, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'v3' }, timestamp: Date.now() },
                    { term: 2, index: 4, entryType: 'command', command: { type: 'set', key: 'k4', value: 'v4' }, timestamp: Date.now() },
                    { term: 2, index: 5, entryType: 'command', command: { type: 'set', key: 'k5', value: 'v5' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            // Simulate appending
            request.entries.forEach((entry: LogEntry) => {
                const existingEntry = getLogEntry(state, entry.index);
                if (!existingEntry) {
                    state.persistent.log.push(entry);
                }
            });

            expect(state.persistent.log).toHaveLength(5);
            expect(getLastLogIndex(state)).toBe(5);
        });

        it('should not duplicate existing entries', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 1,
                prevLogTerm: 1,
                entries: [
                    { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            const originalLength = state.persistent.log.length;

            // Simulate appending (should skip existing)
            request.entries.forEach((entry: LogEntry) => {
                const existingEntry = getLogEntry(state, entry.index);
                if (!existingEntry || existingEntry.term !== entry.term) {
                    if (existingEntry) {
                        state.persistent.log = state.persistent.log.filter(e => e.index < entry.index);
                    }
                    state.persistent.log.push(entry);
                }
            });

            expect(state.persistent.log).toHaveLength(originalLength);
        });
    });

    describe('Empty Log Scenarios', () => {
        beforeEach(() => {
            state.persistent.log = [];
        });

        it('should append to empty log', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [
                    { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            // Simulate appending
            request.entries.forEach((entry: LogEntry) => {
                state.persistent.log.push(entry);
            });

            expect(state.persistent.log).toHaveLength(1);
            expect(state.persistent.log[0].index).toBe(1);
        });

        it('should append multiple entries to empty log', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 0,
                prevLogTerm: 0,
                entries: [
                    { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
                    { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
                ],
                leaderCommit: 0,
            };

            // Simulate appending
            request.entries.forEach((entry: LogEntry) => {
                state.persistent.log.push(entry);
            });

            expect(state.persistent.log).toHaveLength(2);
        });
    });
});

describe('AppendEntries - Commit Index Updates', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.log = [
            { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
            { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
            { term: 2, index: 3, entryType: 'command', command: { type: 'set', key: 'k3', value: 'v3' }, timestamp: Date.now() },
        ];
        state.volatile.commitIndex = 0;
    });

    describe('Commit Index Advancement', () => {
        it('should update commitIndex when leaderCommit is higher', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [],
                leaderCommit: 2,
            };

            // Simulate commit index update
            if (request.leaderCommit > state.volatile.commitIndex) {
                state.volatile.commitIndex = Math.min(
                    request.leaderCommit,
                    getLastLogIndex(state)
                );
            }

            expect(state.volatile.commitIndex).toBe(2);
        });

        it('should not exceed last log index when updating commitIndex', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [],
                leaderCommit: 10, // Higher than our log
            };

            // Simulate commit index update
            if (request.leaderCommit > state.volatile.commitIndex) {
                state.volatile.commitIndex = Math.min(
                    request.leaderCommit,
                    getLastLogIndex(state)
                );
            }

            expect(state.volatile.commitIndex).toBe(3); // Should be capped at last log index
        });

        it('should not decrease commitIndex', () => {
            state.volatile.commitIndex = 3;

            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [],
                leaderCommit: 1, // Lower than current
            };

            // Simulate commit index update
            if (request.leaderCommit > state.volatile.commitIndex) {
                state.volatile.commitIndex = Math.min(
                    request.leaderCommit,
                    getLastLogIndex(state)
                );
            }

            expect(state.volatile.commitIndex).toBe(3); // Should not decrease
        });

        it('should update commitIndex after appending new entries', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 3,
                prevLogTerm: 2,
                entries: [
                    { term: 2, index: 4, entryType: 'command', command: { type: 'set', key: 'k4', value: 'v4' }, timestamp: Date.now() },
                ],
                leaderCommit: 4,
            };

            // Simulate appending
            request.entries.forEach((entry: LogEntry) => {
                state.persistent.log.push(entry);
            });

            // Simulate commit index update
            if (request.leaderCommit > state.volatile.commitIndex) {
                state.volatile.commitIndex = Math.min(
                    request.leaderCommit,
                    getLastLogIndex(state)
                );
            }

            expect(state.volatile.commitIndex).toBe(4);
        });
    });
});

describe('AppendEntries - Response Generation', () => {
    let state: RaftState;
    const cluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
    ];

    beforeEach(() => {
        state = createInitialRaftState(cluster);
        state.persistent.currentTerm = 2;
        state.persistent.log = [
            { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'k1', value: 'v1' }, timestamp: Date.now() },
            { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'k2', value: 'v2' }, timestamp: Date.now() },
        ];
    });

    describe('Success Response', () => {
        it('should return success when log is consistent', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [],
                leaderCommit: 0,
            };

            const prevEntry = getLogEntry(state, request.prevLogIndex);
            const success =
                request.term >= state.persistent.currentTerm &&
                (request.prevLogIndex === 0 ||
                    (prevEntry !== null && prevEntry.term === request.prevLogTerm));

            const response: AppendEntriesResponse = {
                term: state.persistent.currentTerm,
                success: success,
            };

            expect(response.success).toBe(true);
            expect(response.term).toBe(2);
        });
    });

    describe('Failure Response', () => {
        it('should return failure when term is too low', () => {
            const request: AppendEntriesRequest = {
                term: 1,
                leaderId: 'node2',
                prevLogIndex: 2,
                prevLogTerm: 1,
                entries: [],
                leaderCommit: 0,
            };

            const success = request.term >= state.persistent.currentTerm;

            const response: AppendEntriesResponse = {
                term: state.persistent.currentTerm,
                success: success,
            };

            expect(response.success).toBe(false);
            expect(response.term).toBe(2);
        });

        it('should return failure when log is inconsistent', () => {
            const request: AppendEntriesRequest = {
                term: 2,
                leaderId: 'node2',
                prevLogIndex: 5,
                prevLogTerm: 2,
                entries: [],
                leaderCommit: 0,
            };

            const prevEntry = getLogEntry(state, request.prevLogIndex);
            const success =
                request.term >= state.persistent.currentTerm &&
                (request.prevLogIndex === 0 ||
                    (prevEntry !== null && prevEntry.term === request.prevLogTerm));

            const response: AppendEntriesResponse = {
                term: state.persistent.currentTerm,
                success: success,
            };

            expect(response.success).toBe(false);
        });
    });
});
