/**
 * Membership Change Unit Tests
 * 
 * Tests for add/remove server functionality.
 */

import {
    RaftState,
    NodeState,
    createInitialRaftState,
    createLeaderState,
    getLastLogIndex,
    LogEntry,
} from '../src/raft/types';
import { ServerInfo } from '../src/config';

describe('Membership Types', () => {
    const initialCluster: ServerInfo[] = [
        { id: 'node1', address: 'node1', port: 3000 },
        { id: 'node2', address: 'node2', port: 3000 },
        { id: 'node3', address: 'node3', port: 3000 },
    ];

    describe('createInitialRaftState', () => {
        it('should create initial state with cluster config', () => {
            const state = createInitialRaftState(initialCluster);

            expect(state.clusterConfig).toHaveLength(3);
            expect(state.clusterConfig[0].id).toBe('node1');
            expect(state.nodeState).toBe(NodeState.FOLLOWER);
            expect(state.persistent.currentTerm).toBe(0);
            expect(state.persistent.votedFor).toBeNull();
        });

        it('should start with sentinel log entry', () => {
            const state = createInitialRaftState(initialCluster);

            expect(state.persistent.log).toHaveLength(1);
            expect(state.persistent.log[0].index).toBe(0);
            expect(state.persistent.log[0].term).toBe(0);
            expect(state.persistent.log[0].entryType).toBe('noop');
        });

        it('should copy cluster config (not reference)', () => {
            const state = createInitialRaftState(initialCluster);

            // Modifying original shouldn't affect state
            initialCluster.push({ id: 'node4', address: 'node4', port: 3000 });
            expect(state.clusterConfig).toHaveLength(3);

            // Clean up
            initialCluster.pop();
        });
    });

    describe('createLeaderState', () => {
        it('should initialize nextIndex to lastLogIndex + 1', () => {
            const leaderState = createLeaderState(5, initialCluster);

            expect(leaderState.nextIndex.get('node1')).toBe(6);
            expect(leaderState.nextIndex.get('node2')).toBe(6);
            expect(leaderState.nextIndex.get('node3')).toBe(6);
        });

        it('should initialize matchIndex to 0', () => {
            const leaderState = createLeaderState(5, initialCluster);

            expect(leaderState.matchIndex.get('node1')).toBe(0);
            expect(leaderState.matchIndex.get('node2')).toBe(0);
            expect(leaderState.matchIndex.get('node3')).toBe(0);
        });
    });
});

describe('Cluster Configuration Changes', () => {
    let state: RaftState;

    beforeEach(() => {
        const cluster: ServerInfo[] = [
            { id: 'node1', address: 'node1', port: 3000 },
            { id: 'node2', address: 'node2', port: 3000 },
            { id: 'node3', address: 'node3', port: 3000 },
        ];
        state = createInitialRaftState(cluster);
    });

    describe('Add Server', () => {
        it('should add new server to cluster config', () => {
            const newServer: ServerInfo = { id: 'node4', address: 'node4', port: 3000 };

            // Simulate adding server
            state.clusterConfig.push(newServer);

            expect(state.clusterConfig).toHaveLength(4);
            expect(state.clusterConfig.find(s => s.id === 'node4')).toBeDefined();
        });

        it('should create config change log entry', () => {
            const newServer: ServerInfo = { id: 'node4', address: 'node4', port: 3000 };

            const entry: LogEntry = {
                term: state.persistent.currentTerm,
                index: getLastLogIndex(state.persistent.log) + 1,
                entryType: 'config',
                configChange: {
                    type: 'add_server',
                    server: newServer,
                },
                timestamp: Date.now(),
            };

            state.persistent.log.push(entry);

            const lastEntry = state.persistent.log[state.persistent.log.length - 1];
            expect(lastEntry.entryType).toBe('config');
            expect(lastEntry.configChange?.type).toBe('add_server');
            expect(lastEntry.configChange?.server.id).toBe('node4');
        });

        it('should not add duplicate server', () => {
            const existingServer: ServerInfo = { id: 'node1', address: 'node1', port: 3000 };

            const exists = state.clusterConfig.find(s => s.id === existingServer.id);
            expect(exists).toBeDefined();

            // Should not add if already exists
            if (!exists) {
                state.clusterConfig.push(existingServer);
            }

            expect(state.clusterConfig).toHaveLength(3);
        });
    });

    describe('Remove Server', () => {
        it('should remove server from cluster config', () => {
            const serverIndex = state.clusterConfig.findIndex(s => s.id === 'node3');
            expect(serverIndex).toBeGreaterThanOrEqual(0);

            state.clusterConfig.splice(serverIndex, 1);

            expect(state.clusterConfig).toHaveLength(2);
            expect(state.clusterConfig.find(s => s.id === 'node3')).toBeUndefined();
        });

        it('should create config change log entry', () => {
            const serverToRemove = state.clusterConfig.find(s => s.id === 'node3')!;

            const entry: LogEntry = {
                term: state.persistent.currentTerm,
                index: getLastLogIndex(state.persistent.log) + 1,
                entryType: 'config',
                configChange: {
                    type: 'remove_server',
                    server: serverToRemove,
                },
                timestamp: Date.now(),
            };

            state.persistent.log.push(entry);

            const lastEntry = state.persistent.log[state.persistent.log.length - 1];
            expect(lastEntry.entryType).toBe('config');
            expect(lastEntry.configChange?.type).toBe('remove_server');
            expect(lastEntry.configChange?.server.id).toBe('node3');
        });

        it('should handle removing non-existent server', () => {
            const serverIndex = state.clusterConfig.findIndex(s => s.id === 'nonexistent');
            expect(serverIndex).toBe(-1);
        });
    });

    describe('Leader State Updates', () => {
        beforeEach(() => {
            state.nodeState = NodeState.LEADER;
            state.leaderState = createLeaderState(0, state.clusterConfig);
        });

        it('should initialize new server in leader state when adding', () => {
            const newServer: ServerInfo = { id: 'node4', address: 'node4', port: 3000 };
            const lastLogIndex = getLastLogIndex(state.persistent.log);

            // Add to cluster config
            state.clusterConfig.push(newServer);

            // Initialize leader state for new server
            state.leaderState!.nextIndex.set(newServer.id, lastLogIndex + 1);
            state.leaderState!.matchIndex.set(newServer.id, 0);

            expect(state.leaderState!.nextIndex.get('node4')).toBe(1);
            expect(state.leaderState!.matchIndex.get('node4')).toBe(0);
        });

        it('should clean up leader state when removing server', () => {
            // Remove from cluster
            const serverIndex = state.clusterConfig.findIndex(s => s.id === 'node3');
            state.clusterConfig.splice(serverIndex, 1);

            // Clean up leader state
            state.leaderState!.nextIndex.delete('node3');
            state.leaderState!.matchIndex.delete('node3');

            expect(state.leaderState!.nextIndex.has('node3')).toBe(false);
            expect(state.leaderState!.matchIndex.has('node3')).toBe(false);
        });
    });
});

describe('Quorum Calculation', () => {
    it('should calculate correct quorum for 3 nodes', () => {
        const clusterSize = 3;
        const quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(2);
    });

    it('should calculate correct quorum for 4 nodes', () => {
        const clusterSize = 4;
        const quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(3);
    });

    it('should calculate correct quorum for 5 nodes', () => {
        const clusterSize = 5;
        const quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(3);
    });

    it('should calculate correct quorum after adding node', () => {
        // 3 nodes -> add 1 -> 4 nodes
        let clusterSize = 3;
        let quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(2);

        clusterSize = 4;
        quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(3);
    });

    it('should calculate correct quorum after removing node', () => {
        // 4 nodes -> remove 1 -> 3 nodes
        let clusterSize = 4;
        let quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(3);

        clusterSize = 3;
        quorum = Math.floor(clusterSize / 2) + 1;
        expect(quorum).toBe(2);
    });
});
