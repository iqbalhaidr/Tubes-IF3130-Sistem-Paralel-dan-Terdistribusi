/**
 * Log Replication Unit Tests (Person 3)
 * 
 * Tests for the log replication mechanism in Raft:
 * - Log entry creation and management
 * - Commit index calculation
 * - State machine application
 * - Conflict resolution
 */

import {
    LogEntry,
    Command,
    ConfigChange,
    createInitialRaftState,
    createLeaderState,
    getLastLogIndex,
    getLastLogTerm,
    NodeState,
} from '../src/raft/types';
import { ServerInfo } from '../src/config';

// Mock cluster configuration for tests
const testCluster: ServerInfo[] = [
    { id: 'node1', address: 'node1', port: 3000 },
    { id: 'node2', address: 'node2', port: 3000 },
    { id: 'node3', address: 'node3', port: 3000 },
];

describe('Log Replication', () => {
    describe('Log Entry Creation', () => {
        it('should create initial state with sentinel entry', () => {
            const state = createInitialRaftState(testCluster);

            // Log should have sentinel entry at index 0
            expect(state.persistent.log.length).toBe(1);
            expect(state.persistent.log[0].index).toBe(0);
            expect(state.persistent.log[0].term).toBe(0);
            expect(state.persistent.log[0].entryType).toBe('noop');
        });

        it('should create command log entry with correct structure', () => {
            const command: Command = { type: 'set', key: 'foo', value: 'bar' };
            const entry: LogEntry = {
                term: 1,
                index: 1,
                entryType: 'command',
                command,
                timestamp: Date.now(),
            };

            expect(entry.term).toBe(1);
            expect(entry.index).toBe(1);
            expect(entry.command).toEqual(command);
        });

        it('should create config log entry with correct structure', () => {
            const configChange: ConfigChange = {
                type: 'add_server',
                server: { id: 'node4', address: 'node4', port: 3000 },
            };
            const entry: LogEntry = {
                term: 2,
                index: 3,
                entryType: 'config',
                configChange,
                timestamp: Date.now(),
            };

            expect(entry.entryType).toBe('config');
            expect(entry.configChange).toEqual(configChange);
        });
    });

    describe('Log Index Helpers', () => {
        it('getLastLogIndex should return 0 for initial log', () => {
            const state = createInitialRaftState(testCluster);
            expect(getLastLogIndex(state.persistent.log)).toBe(0);
        });

        it('getLastLogIndex should return correct index after entries', () => {
            const state = createInitialRaftState(testCluster);

            // Add some entries
            state.persistent.log.push({
                term: 1,
                index: 1,
                entryType: 'command',
                command: { type: 'set', key: 'a', value: '1' },
                timestamp: Date.now(),
            });
            state.persistent.log.push({
                term: 1,
                index: 2,
                entryType: 'command',
                command: { type: 'set', key: 'b', value: '2' },
                timestamp: Date.now(),
            });

            expect(getLastLogIndex(state.persistent.log)).toBe(2);
        });

        it('getLastLogTerm should return 0 for initial log', () => {
            const state = createInitialRaftState(testCluster);
            expect(getLastLogTerm(state.persistent.log)).toBe(0);
        });

        it('getLastLogTerm should return correct term after entries', () => {
            const state = createInitialRaftState(testCluster);

            state.persistent.log.push({
                term: 3,
                index: 1,
                entryType: 'command',
                command: { type: 'set', key: 'a', value: '1' },
                timestamp: Date.now(),
            });

            expect(getLastLogTerm(state.persistent.log)).toBe(3);
        });
    });

    describe('Leader State Initialization', () => {
        it('should initialize nextIndex for all servers', () => {
            const lastLogIndex = 5;
            const leaderState = createLeaderState(lastLogIndex, testCluster);

            // nextIndex should be lastLogIndex + 1 for all servers
            for (const server of testCluster) {
                expect(leaderState.nextIndex.get(server.id)).toBe(6);
            }
        });

        it('should initialize matchIndex to 0 for all servers', () => {
            const lastLogIndex = 5;
            const leaderState = createLeaderState(lastLogIndex, testCluster);

            // matchIndex should be 0 for all servers
            for (const server of testCluster) {
                expect(leaderState.matchIndex.get(server.id)).toBe(0);
            }
        });
    });

    describe('Commit Index Calculation', () => {
        /**
         * Helper to calculate commit index from matchIndices
         * Mirrors the logic in RaftNode.updateCommitIndex
         */
        function calculateCommitIndex(
            matchIndices: number[],
            clusterSize: number,
            log: LogEntry[],
            currentTerm: number,
            currentCommitIndex: number
        ): number {
            // Sort in descending order
            const sorted = [...matchIndices].sort((a, b) => b - a);

            // Find the majority position
            const quorumIndex = Math.floor(clusterSize / 2);

            if (quorumIndex < sorted.length) {
                const newCommitIndex = sorted[quorumIndex];

                // Only commit entries from current term
                if (newCommitIndex > currentCommitIndex &&
                    log[newCommitIndex]?.term === currentTerm) {
                    return newCommitIndex;
                }
            }

            return currentCommitIndex;
        }

        it('should advance commit index when majority matches', () => {
            const log: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            // Majority (2/3) have replicated index 1
            const matchIndices = [1, 1, 0]; // node1=1, node2=1, node3=0

            const newCommitIndex = calculateCommitIndex(matchIndices, 3, log, 1, 0);
            expect(newCommitIndex).toBe(1);
        });

        it('should not advance if less than majority matches', () => {
            const log: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            // Only 1/3 have replicated index 1
            const matchIndices = [1, 0, 0];

            const newCommitIndex = calculateCommitIndex(matchIndices, 3, log, 1, 0);
            expect(newCommitIndex).toBe(0);
        });

        it('should only commit entries from current term', () => {
            const log: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            // Majority have replicated, but entry is from term 1, current term is 2
            const matchIndices = [1, 1, 1];

            const newCommitIndex = calculateCommitIndex(matchIndices, 3, log, 2, 0);
            expect(newCommitIndex).toBe(0); // Should not advance (safety guarantee)
        });

        it('should handle 4-node cluster correctly', () => {
            const log: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
                { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'b', value: '2' }, timestamp: 0 },
            ];

            // For 4 nodes, need 3 (floor(4/2) + 1 = 3) to agree
            // But our algorithm uses quorumIndex = floor(4/2) = 2 (0-indexed position)
            // matchIndices sorted: [2, 2, 1, 0]
            // Position 2 has value 1, so commitIndex would be 1
            const matchIndices = [2, 2, 1, 0];

            const newCommitIndex = calculateCommitIndex(matchIndices, 4, log, 1, 0);
            expect(newCommitIndex).toBe(1);
        });
    });

    describe('Log Conflict Resolution', () => {
        /**
         * Simulates the conflict resolution logic from handleAppendEntries
         */
        function resolveConflicts(existingLog: LogEntry[], newEntries: LogEntry[]): LogEntry[] {
            const log = [...existingLog];

            for (const entry of newEntries) {
                if (entry.index < log.length) {
                    if (log[entry.index].term !== entry.term) {
                        // Conflict! Delete this entry and everything after
                        log.splice(entry.index);
                        log.push(entry);
                    }
                    // If terms match, entry is already there
                } else {
                    log.push(entry);
                }
            }

            return log;
        }

        it('should append new entries to empty log', () => {
            const existingLog: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
            ];

            const newEntries: LogEntry[] = [
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            const result = resolveConflicts(existingLog, newEntries);
            expect(result.length).toBe(2);
            expect(result[1].command?.key).toBe('a');
        });

        it('should not duplicate existing entries with same term', () => {
            const existingLog: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            const newEntries: LogEntry[] = [
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
            ];

            const result = resolveConflicts(existingLog, newEntries);
            expect(result.length).toBe(2); // No duplication
        });

        it('should delete conflicting entries and append new ones', () => {
            const existingLog: LogEntry[] = [
                { term: 0, index: 0, entryType: 'noop', timestamp: 0 },
                { term: 1, index: 1, entryType: 'command', command: { type: 'set', key: 'a', value: '1' }, timestamp: 0 },
                { term: 1, index: 2, entryType: 'command', command: { type: 'set', key: 'b', value: '2' }, timestamp: 0 },
            ];

            // New entry at index 1 with different term - conflict!
            const newEntries: LogEntry[] = [
                { term: 2, index: 1, entryType: 'command', command: { type: 'set', key: 'x', value: 'y' }, timestamp: 0 },
            ];

            const result = resolveConflicts(existingLog, newEntries);

            // Should have deleted index 1 and 2, then appended new entry
            expect(result.length).toBe(2);
            expect(result[1].term).toBe(2);
            expect(result[1].command?.key).toBe('x');
        });
    });

    describe('Command Building', () => {
        /**
         * Test buildCommand logic
         */
        function buildCommand(command: string, args: string[]): Command {
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

        it('should build SET command correctly', () => {
            const cmd = buildCommand('set', ['key1', 'value1']);
            expect(cmd.type).toBe('set');
            expect(cmd.key).toBe('key1');
            expect(cmd.value).toBe('value1');
        });

        it('should build DEL command correctly', () => {
            const cmd = buildCommand('del', ['key1']);
            expect(cmd.type).toBe('del');
            expect(cmd.key).toBe('key1');
            expect(cmd.value).toBeUndefined();
        });

        it('should build APPEND command correctly', () => {
            const cmd = buildCommand('append', ['key1', 'suffix']);
            expect(cmd.type).toBe('append');
            expect(cmd.key).toBe('key1');
            expect(cmd.value).toBe('suffix');
        });

        it('should handle case insensitivity', () => {
            const cmd1 = buildCommand('SET', ['k', 'v']);
            const cmd2 = buildCommand('Set', ['k', 'v']);

            expect(cmd1.type).toBe('set');
            expect(cmd2.type).toBe('set');
        });

        it('should throw for unknown command', () => {
            expect(() => buildCommand('invalid', [])).toThrow('Unknown command type');
        });
    });

    describe('State Machine Application', () => {
        /**
         * Simulates applyCommand logic
         */
        interface SimpleKVStore {
            data: Map<string, string>;
        }

        function applyCommand(store: SimpleKVStore, command: Command): string {
            switch (command.type) {
                case 'set':
                    store.data.set(command.key, command.value || '');
                    return 'OK';
                case 'del':
                    const oldValue = store.data.get(command.key) || '';
                    store.data.delete(command.key);
                    return `"${oldValue}"`;
                case 'append':
                    const current = store.data.get(command.key) || '';
                    store.data.set(command.key, current + (command.value || ''));
                    return 'OK';
                default:
                    return 'ERROR: Unknown command';
            }
        }

        it('should apply SET command', () => {
            const store: SimpleKVStore = { data: new Map() };
            const result = applyCommand(store, { type: 'set', key: 'foo', value: 'bar' });

            expect(result).toBe('OK');
            expect(store.data.get('foo')).toBe('bar');
        });

        it('should apply DEL command', () => {
            const store: SimpleKVStore = { data: new Map([['foo', 'bar']]) };
            const result = applyCommand(store, { type: 'del', key: 'foo' });

            expect(result).toBe('"bar"');
            expect(store.data.has('foo')).toBe(false);
        });

        it('should apply APPEND command', () => {
            const store: SimpleKVStore = { data: new Map([['foo', 'hello']]) };
            const result = applyCommand(store, { type: 'append', key: 'foo', value: 'world' });

            expect(result).toBe('OK');
            expect(store.data.get('foo')).toBe('helloworld');
        });

        it('should apply APPEND to non-existent key', () => {
            const store: SimpleKVStore = { data: new Map() };
            const result = applyCommand(store, { type: 'append', key: 'foo', value: 'bar' });

            expect(result).toBe('OK');
            expect(store.data.get('foo')).toBe('bar');
        });

        it('should apply sequence of commands correctly (demo scenario)', () => {
            const store: SimpleKVStore = { data: new Map() };

            // Simulate demo scenario:
            // set("1", "A")
            applyCommand(store, { type: 'set', key: '1', value: 'A' });
            expect(store.data.get('1')).toBe('A');

            // append("1", "BC")
            applyCommand(store, { type: 'append', key: '1', value: 'BC' });
            expect(store.data.get('1')).toBe('ABC');

            // set("2", "SI")
            applyCommand(store, { type: 'set', key: '2', value: 'SI' });
            expect(store.data.get('2')).toBe('SI');

            // append("2", "S")
            applyCommand(store, { type: 'append', key: '2', value: 'S' });
            expect(store.data.get('2')).toBe('SIS');
        });
    });
});
