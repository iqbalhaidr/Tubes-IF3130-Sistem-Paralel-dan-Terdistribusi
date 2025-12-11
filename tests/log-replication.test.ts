/**
 * Log Replication Test
 * 
 * Tests for Raft log replication functionality.
 * This test suite validates that commands are properly replicated
 * across the cluster and executed consistently on all nodes.
 * 
 * Prerequisites:
 * - Docker cluster must be running (4 nodes)
 * - Run: cd docker && docker-compose up -d
 */

import { RpcClient } from '../src/rpc/client';
import { ServerInfo } from '../src/config';
import {
    ExecuteRequest,
    ExecuteResponse,
} from '../src/rpc/types';

describe('Log Replication Tests', () => {
    let rpcClient: RpcClient;
    let nodes: ServerInfo[];
    let leader: ServerInfo | null = null;

    beforeAll(async () => {
        // Initialize RPC client
        rpcClient = new RpcClient({ timeout: 10000, retries: 2 });

        // Define cluster nodes
        nodes = [
            { id: 'node1', address: 'localhost', port: 3001 },
            { id: 'node2', address: 'localhost', port: 3002 },
            { id: 'node3', address: 'localhost', port: 3003 },
            { id: 'node4', address: 'localhost', port: 3004 },
        ];

        // Find the leader
        leader = await findLeader();
        expect(leader).not.toBeNull();
    });

    /**
     * Find the current leader by trying each node
     */
    async function findLeader(): Promise<ServerInfo | null> {
        for (const node of nodes) {
            try {
                const response = await rpcClient.call<ExecuteResponse>(
                    node,
                    'execute',
                    { command: 'ping', args: [] } as ExecuteRequest
                );

                if (response.success && response.leaderId === node.id) {
                    console.log(`Found leader: ${node.id}`);
                    return node;
                }

                // If this node is not the leader, use the leaderId hint
                if (response.leaderId) {
                    const leaderNode = nodes.find(n => n.id === response.leaderId);
                    if (leaderNode) {
                        console.log(`Found leader via redirect: ${leaderNode.id}`);
                        return leaderNode;
                    }
                }
            } catch (error) {
                // Node might be down, try next
                continue;
            }
        }
        return null;
    }

    /**
     * Execute a command on a specific node
     */
    async function executeCommand(
        node: ServerInfo,
        command: string,
        args: string[]
    ): Promise<ExecuteResponse> {
        return await rpcClient.call<ExecuteResponse>(
            node,
            'execute',
            { command, args } as ExecuteRequest
        );
    }

    /**
     * Get a non-leader node
     */
    function getNonLeader(): ServerInfo {
        const nonLeader = nodes.find(n => n.id !== leader?.id);
        if (!nonLeader) {
            throw new Error('No non-leader node available');
        }
        return nonLeader;
    }

    /**
     * Get multiple non-leader nodes
     */
    function getNonLeaders(count: number): ServerInfo[] {
        const nonLeaders = nodes.filter(n => n.id !== leader?.id);
        return nonLeaders.slice(0, count);
    }

    /**
     * Wait for log replication to propagate
     */
    async function waitForReplication(ms: number = 500): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    describe('Test 1: Basic Log Replication to Leader', () => {
        it('should execute set("1", "A") on leader', async () => {
            if (!leader) throw new Error('No leader found');

            const response = await executeCommand(leader, 'set', ['1', 'A']);
            expect(response.success).toBe(true);
            expect(response.result).toBe('OK');
        });

        it('should execute append("1", "BC") on leader', async () => {
            if (!leader) throw new Error('No leader found');

            const response = await executeCommand(leader, 'append', ['1', 'BC']);
            expect(response.success).toBe(true);
            expect(response.result).toBe('OK');
        });

        it('should execute set("2", "SI") on leader', async () => {
            if (!leader) throw new Error('No leader found');

            const response = await executeCommand(leader, 'set', ['2', 'SI']);
            expect(response.success).toBe(true);
            expect(response.result).toBe('OK');
        });

        it('should execute append("2", "S") on leader', async () => {
            if (!leader) throw new Error('No leader found');

            const response = await executeCommand(leader, 'append', ['2', 'S']);
            expect(response.success).toBe(true);
            expect(response.result).toBe('OK');
        });

        it('should get("1") return "ABC" on leader', async () => {
            if (!leader) throw new Error('No leader found');

            const response = await executeCommand(leader, 'get', ['1']);
            expect(response.success).toBe(true);
            expect(response.result).toBe('"ABC"');
        });
    });

    describe('Test 2: Read from Non-Leader (with redirect)', () => {
        beforeAll(async () => {
            // Wait for replication to complete
            await waitForReplication(1000);
        });

        it('should get("1") from non-leader node', async () => {
            const nonLeader = getNonLeader();

            const response = await executeCommand(nonLeader, 'get', ['1']);
            
            // Non-leader might redirect to leader, but should eventually return correct value
            expect(response.success).toBe(true);
            expect(response.result).toBe('"ABC"');
        });

        it('should get("2") from non-leader node', async () => {
            const nonLeader = getNonLeader();

            const response = await executeCommand(nonLeader, 'get', ['2']);
            
            expect(response.success).toBe(true);
            expect(response.result).toBe('"SIS"');
        });
    });

    describe('Test 3: Concurrent Writes from Multiple Clients', () => {
        it('should handle concurrent writes from two clients', async () => {
            if (!leader) throw new Error('No leader found');

            // Execute commands concurrently
            const [response1a, response2a] = await Promise.all([
                executeCommand(leader, 'set', ['ruby-chan', 'choco-minto']),
                executeCommand(leader, 'set', ['ayumu-chan', 'strawberry-flavor']),
            ]);

            expect(response1a.success).toBe(true);
            expect(response1a.result).toBe('OK');
            expect(response2a.success).toBe(true);
            expect(response2a.result).toBe('OK');

            // Wait a bit for replication
            await waitForReplication(500);

            // Execute append commands concurrently
            const [response1b, response2b] = await Promise.all([
                executeCommand(leader, 'append', ['ruby-chan', '-yori-mo-anata']),
                executeCommand(leader, 'append', ['ayumu-chan', '-yori-mo-anata']),
            ]);

            expect(response1b.success).toBe(true);
            expect(response1b.result).toBe('OK');
            expect(response2b.success).toBe(true);
            expect(response2b.result).toBe('OK');
        });
    });

    describe('Test 4: Read from Different Non-Leader Nodes', () => {
        beforeAll(async () => {
            // Wait for replication to complete
            await waitForReplication(1000);
        });

        it('should get("ruby-chan") from first non-leader', async () => {
            const nonLeaders = getNonLeaders(2);
            expect(nonLeaders.length).toBeGreaterThanOrEqual(2);

            const response = await executeCommand(nonLeaders[0], 'get', ['ruby-chan']);
            
            expect(response.success).toBe(true);
            expect(response.result).toBe('"choco-minto-yori-mo-anata"');
        });

        it('should get("ayumu-chan") from second non-leader', async () => {
            const nonLeaders = getNonLeaders(2);
            expect(nonLeaders.length).toBeGreaterThanOrEqual(2);

            const response = await executeCommand(nonLeaders[1], 'get', ['ayumu-chan']);
            
            expect(response.success).toBe(true);
            expect(response.result).toBe('"strawberry-flavor-yori-mo-anata"');
        });

        it('should verify consistency across all nodes', async () => {
            // Wait for full replication
            await waitForReplication(1000);

            // Try to read from all nodes (including leader)
            const results = await Promise.allSettled(
                nodes.map(node => executeCommand(node, 'get', ['ruby-chan']))
            );

            // Count successful reads
            const successfulReads = results.filter(
                r => r.status === 'fulfilled' && r.value.success
            );

            // At least majority should be able to read (including redirects)
            expect(successfulReads.length).toBeGreaterThanOrEqual(Math.floor(nodes.length / 2) + 1);

            // All successful reads should return the same value
            const values = successfulReads.map(
                r => (r as PromiseFulfilledResult<ExecuteResponse>).value.result
            );
            const uniqueValues = new Set(values);
            expect(uniqueValues.size).toBe(1);
            expect(Array.from(uniqueValues)[0]).toBe('"choco-minto-yori-mo-anata"');
        });
    });

    describe('Additional Verification Tests', () => {
        it('should verify all keys are consistent', async () => {
            if (!leader) throw new Error('No leader found');

            await waitForReplication(1000);

            // Verify key "1"
            const response1 = await executeCommand(leader, 'get', ['1']);
            expect(response1.success).toBe(true);
            expect(response1.result).toBe('"ABC"');

            // Verify key "2"
            const response2 = await executeCommand(leader, 'get', ['2']);
            expect(response2.success).toBe(true);
            expect(response2.result).toBe('"SIS"');

            // Verify key "ruby-chan"
            const response3 = await executeCommand(leader, 'get', ['ruby-chan']);
            expect(response3.success).toBe(true);
            expect(response3.result).toBe('"choco-minto-yori-mo-anata"');

            // Verify key "ayumu-chan"
            const response4 = await executeCommand(leader, 'get', ['ayumu-chan']);
            expect(response4.success).toBe(true);
            expect(response4.result).toBe('"strawberry-flavor-yori-mo-anata"');
        });

        it('should handle strln on replicated data', async () => {
            if (!leader) throw new Error('No leader found');

            // Check length of "ABC"
            const response1 = await executeCommand(leader, 'strln', ['1']);
            expect(response1.success).toBe(true);
            expect(response1.result).toBe('3');

            // Check length of "choco-minto-yori-mo-anata"
            const response2 = await executeCommand(leader, 'strln', ['ruby-chan']);
            expect(response2.success).toBe(true);
            expect(response2.result).toBe('26');
        });
    });
});

/**
 * Test Summary:
 * 
 * This test suite validates the following aspects of log replication:
 * 
 * 1. Basic writes to leader are replicated
 * 2. Reads from non-leader nodes work (with redirect)
 * 3. Concurrent writes are handled correctly
 * 4. Data consistency across all nodes
 * 
 * To run these tests:
 * 1. Start Docker cluster: cd docker && docker-compose up -d
 * 2. Wait for leader election: sleep 15
 * 3. Run tests: npm test -- tests/log-replication.test.ts
 * 
 * Expected behavior:
 * - All write operations should succeed and return "OK"
 * - All read operations should return consistent values
 * - Non-leader nodes should redirect to leader for writes
 * - Concurrent operations should be serialized properly
 * - All nodes should eventually have the same data
 */
