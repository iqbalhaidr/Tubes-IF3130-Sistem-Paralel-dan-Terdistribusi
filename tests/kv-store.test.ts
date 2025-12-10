/**
 * Key-Value Store Unit Tests
 * 
 * Tests for the in-memory key-value store operations.
 */

import { KeyValueStore, executeKvCommand, IKeyValueStore } from '../src/store/kv-store';

describe('KeyValueStore', () => {
    let store: KeyValueStore;

    beforeEach(() => {
        store = new KeyValueStore();
    });

    describe('get', () => {
        it('should return empty string for non-existent key', () => {
            expect(store.get('nonexistent')).toBe('');
        });

        it('should return value for existing key', () => {
            store.set('key', 'value');
            expect(store.get('key')).toBe('value');
        });
    });

    describe('set', () => {
        it('should set a new key', () => {
            store.set('key', 'value');
            expect(store.get('key')).toBe('value');
        });

        it('should overwrite existing key', () => {
            store.set('key', 'old');
            store.set('key', 'new');
            expect(store.get('key')).toBe('new');
        });

        it('should handle empty string value', () => {
            store.set('key', '');
            expect(store.get('key')).toBe('');
        });

        it('should handle special characters', () => {
            store.set('key', 'hello\nworld\t!');
            expect(store.get('key')).toBe('hello\nworld\t!');
        });
    });

    describe('strln', () => {
        it('should return 0 for non-existent key', () => {
            expect(store.strln('nonexistent')).toBe(0);
        });

        it('should return correct length', () => {
            store.set('key', 'hello');
            expect(store.strln('key')).toBe(5);
        });

        it('should return 0 for empty string', () => {
            store.set('key', '');
            expect(store.strln('key')).toBe(0);
        });
    });

    describe('del', () => {
        it('should return empty string for non-existent key', () => {
            expect(store.del('nonexistent')).toBe('');
        });

        it('should delete key and return value', () => {
            store.set('key', 'value');
            expect(store.del('key')).toBe('value');
            expect(store.get('key')).toBe('');
        });

        it('should only delete specified key', () => {
            store.set('key1', 'value1');
            store.set('key2', 'value2');
            store.del('key1');
            expect(store.get('key1')).toBe('');
            expect(store.get('key2')).toBe('value2');
        });
    });

    describe('append', () => {
        it('should create key with value if not exists', () => {
            store.append('key', 'hello');
            expect(store.get('key')).toBe('hello');
        });

        it('should append to existing value', () => {
            store.set('key', 'hello');
            store.append('key', 'world');
            expect(store.get('key')).toBe('helloworld');
        });

        it('should handle empty string append', () => {
            store.set('key', 'hello');
            store.append('key', '');
            expect(store.get('key')).toBe('hello');
        });
    });

    describe('getAll', () => {
        it('should return empty map initially', () => {
            const all = store.getAll();
            expect(all.size).toBe(0);
        });

        it('should return all entries', () => {
            store.set('key1', 'value1');
            store.set('key2', 'value2');
            const all = store.getAll();
            expect(all.size).toBe(2);
            expect(all.get('key1')).toBe('value1');
            expect(all.get('key2')).toBe('value2');
        });

        it('should return a copy (not affect original)', () => {
            store.set('key', 'value');
            const all = store.getAll();
            all.set('key', 'modified');
            expect(store.get('key')).toBe('value');
        });
    });

    describe('clear', () => {
        it('should remove all entries', () => {
            store.set('key1', 'value1');
            store.set('key2', 'value2');
            store.clear();
            expect(store.size()).toBe(0);
            expect(store.get('key1')).toBe('');
        });
    });

    describe('size', () => {
        it('should return 0 initially', () => {
            expect(store.size()).toBe(0);
        });

        it('should return correct size', () => {
            store.set('key1', 'value1');
            expect(store.size()).toBe(1);
            store.set('key2', 'value2');
            expect(store.size()).toBe(2);
        });

        it('should decrease after delete', () => {
            store.set('key', 'value');
            expect(store.size()).toBe(1);
            store.del('key');
            expect(store.size()).toBe(0);
        });
    });
});

describe('executeKvCommand', () => {
    let store: IKeyValueStore;

    beforeEach(() => {
        store = new KeyValueStore();
    });

    describe('ping', () => {
        it('should return PONG', () => {
            expect(executeKvCommand(store, 'ping', [])).toBe('PONG');
        });

        it('should be case insensitive', () => {
            expect(executeKvCommand(store, 'PING', [])).toBe('PONG');
            expect(executeKvCommand(store, 'Ping', [])).toBe('PONG');
        });
    });

    describe('get', () => {
        it('should return quoted empty string for non-existent key', () => {
            expect(executeKvCommand(store, 'get', ['key'])).toBe('""');
        });

        it('should return quoted value for existing key', () => {
            store.set('key', 'value');
            expect(executeKvCommand(store, 'get', ['key'])).toBe('"value"');
        });

        it('should throw without key argument', () => {
            expect(() => executeKvCommand(store, 'get', [])).toThrow('GET requires a key argument');
        });
    });

    describe('set', () => {
        it('should return OK', () => {
            expect(executeKvCommand(store, 'set', ['key', 'value'])).toBe('OK');
        });

        it('should actually set the value', () => {
            executeKvCommand(store, 'set', ['key', 'value']);
            expect(store.get('key')).toBe('value');
        });

        it('should throw without enough arguments', () => {
            expect(() => executeKvCommand(store, 'set', ['key'])).toThrow('SET requires key and value arguments');
            expect(() => executeKvCommand(store, 'set', [])).toThrow('SET requires key and value arguments');
        });
    });

    describe('strln', () => {
        it('should return length as string', () => {
            store.set('key', 'hello');
            expect(executeKvCommand(store, 'strln', ['key'])).toBe('5');
        });

        it('should return 0 for non-existent key', () => {
            expect(executeKvCommand(store, 'strln', ['nonexistent'])).toBe('0');
        });

        it('should throw without key argument', () => {
            expect(() => executeKvCommand(store, 'strln', [])).toThrow('STRLN requires a key argument');
        });
    });

    describe('del', () => {
        it('should return quoted deleted value', () => {
            store.set('key', 'value');
            expect(executeKvCommand(store, 'del', ['key'])).toBe('"value"');
        });

        it('should return quoted empty string for non-existent key', () => {
            expect(executeKvCommand(store, 'del', ['nonexistent'])).toBe('""');
        });

        it('should throw without key argument', () => {
            expect(() => executeKvCommand(store, 'del', [])).toThrow('DEL requires a key argument');
        });
    });

    describe('append', () => {
        it('should return OK', () => {
            expect(executeKvCommand(store, 'append', ['key', 'value'])).toBe('OK');
        });

        it('should actually append the value', () => {
            store.set('key', 'hello');
            executeKvCommand(store, 'append', ['key', 'world']);
            expect(store.get('key')).toBe('helloworld');
        });

        it('should throw without enough arguments', () => {
            expect(() => executeKvCommand(store, 'append', ['key'])).toThrow('APPEND requires key and value arguments');
        });
    });

    describe('unknown command', () => {
        it('should throw for unknown command', () => {
            expect(() => executeKvCommand(store, 'unknown', [])).toThrow('Unknown command: unknown');
        });
    });
});
