/**
 * Key-Value Store Module, provides the in-memory key-value store that serves as the
 * state machine for the Raft cluster.
 * 
 * @module store/kv-store
 */

import { Logger } from '../utils/logger';

const logger = new Logger('KV-Store');

/**
 * Interface for the Key-Value Store
 */
export interface IKeyValueStore {
    get(key: string): string;
    set(key: string, value: string): void;
    strln(key: string): number;
    del(key: string): string;
    append(key: string, value: string): void;
    getAll(): Map<string, string>;
    clear(): void;
}

/**
 * In-memory Key-Value Store implementation -> for committed log entries
 */
export class KeyValueStore implements IKeyValueStore {
    private store: Map<string, string> = new Map();

    /**
     * Get a value by key
     * Returns empty string if key doesn't exist
     * 
     * @param key - Key to look up
     * @returns Value or empty string
     */
    get(key: string): string {
        const value = this.store.get(key);
        logger.debug(`GET ${key} = "${value ?? ''}"`);
        return value ?? '';
    }

    /**
     * Set a key to a value
     * Overwrites if key already exists
     * 
     * @param key - Key to set
     * @param value - Value to store
     */
    set(key: string, value: string): void {
        logger.debug(`SET ${key} = "${value}"`);
        this.store.set(key, value);
    }

    /**
     * Get the length of a value
     * Returns 0 if key doesn't exist
     * 
     * @param key - Key to check
     * @returns Length of the value
     */
    strln(key: string): number {
        const value = this.store.get(key);
        const length = value?.length ?? 0;
        logger.debug(`STRLN ${key} = ${length}`);
        return length;
    }

    /**
     * Delete a key and return its value
     * Returns empty string if key doesn't exist
     * 
     * @param key - Key to delete
     * @returns Deleted value or empty string
     */
    del(key: string): string {
        const value = this.store.get(key) ?? '';
        this.store.delete(key);
        logger.debug(`DEL ${key} = "${value}"`);
        return value;
    }

    /**
     * Append to a value
     * Creates key with empty string if it doesn't exist
     * 
     * @param key - Key to append to
     * @param value - Value to append
     */
    append(key: string, value: string): void {
        const existing = this.store.get(key) ?? '';
        const newValue = existing + value;
        this.store.set(key, newValue);
        logger.debug(`APPEND ${key} += "${value}" -> "${newValue}"`);
    }

    /**
     * Get all entries (for debugging/snapshot)
     */
    getAll(): Map<string, string> {
        return new Map(this.store);
    }

    /**
     * Clear all entries
     */
    clear(): void {
        logger.debug('CLEAR store');
        this.store.clear();
    }

    /**
     * Get the number of entries
     */
    size(): number {
        return this.store.size;
    }
}

/**
 * Execute a command on the key-value store
 * 
 * @param store - The key-value store
 * @param command - Command to execute
 * @param args - Command arguments
 * @returns Result string
 */
export function executeKvCommand(
    store: IKeyValueStore,
    command: string,
    args: string[]
): string {
    switch (command.toLowerCase()) {
        case 'ping':
            return 'PONG';

        case 'get':
            if (args.length < 1) {
                throw new Error('GET requires a key argument');
            }
            const getValue = store.get(args[0]);
            return getValue === '' ? '""' : `"${getValue}"`;

        case 'set':
            if (args.length < 2) {
                throw new Error('SET requires key and value arguments');
            }
            store.set(args[0], args[1]);
            return 'OK';

        case 'strln':
            if (args.length < 1) {
                throw new Error('STRLN requires a key argument');
            }
            return String(store.strln(args[0]));

        case 'del':
            if (args.length < 1) {
                throw new Error('DEL requires a key argument');
            }
            const delValue = store.del(args[0]);
            return delValue === '' ? '""' : `"${delValue}"`;

        case 'append':
            if (args.length < 2) {
                throw new Error('APPEND requires key and value arguments');
            }
            store.append(args[0], args[1]);
            return 'OK';

        default:
            throw new Error(`Unknown command: ${command}`);
    }
}
