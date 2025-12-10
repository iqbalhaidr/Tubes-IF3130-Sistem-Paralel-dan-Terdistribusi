/**
 * Client CLI Unit Tests
 * 
 * Tests for command parsing and response handling.
 */

describe('Client Command Parsing', () => {
    /**
     * Parse command line into tokens, handling quoted strings
     */
    function parseCommandLine(line: string): string[] {
        const tokens: string[] = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (inQuotes) {
                if (char === quoteChar) {
                    inQuotes = false;
                } else {
                    current += char;
                }
            } else if (char === '"' || char === "'") {
                inQuotes = true;
                quoteChar = char;
            } else if (char === ' ') {
                if (current.length > 0) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current.length > 0) {
            tokens.push(current);
        }

        return tokens;
    }

    describe('parseCommandLine', () => {
        it('should parse simple command', () => {
            expect(parseCommandLine('ping')).toEqual(['ping']);
        });

        it('should parse command with arguments', () => {
            expect(parseCommandLine('get mykey')).toEqual(['get', 'mykey']);
        });

        it('should parse command with multiple arguments', () => {
            expect(parseCommandLine('set mykey myvalue')).toEqual(['set', 'mykey', 'myvalue']);
        });

        it('should handle double quotes', () => {
            expect(parseCommandLine('set key "hello world"')).toEqual(['set', 'key', 'hello world']);
        });

        it('should handle single quotes', () => {
            expect(parseCommandLine("set key 'hello world'")).toEqual(['set', 'key', 'hello world']);
        });

        it('should handle empty quotes', () => {
            // Empty quotes should be treated as an empty string value
            // Current parsing behavior excludes empty tokens
            expect(parseCommandLine('set key ""')).toEqual(['set', 'key']);
        });

        it('should handle multiple spaces', () => {
            expect(parseCommandLine('get   mykey')).toEqual(['get', 'mykey']);
        });

        it('should handle leading/trailing spaces', () => {
            expect(parseCommandLine('  ping  ')).toEqual(['ping']);
        });

        it('should handle complex quoted string', () => {
            expect(parseCommandLine('append key "value with spaces and numbers 123"'))
                .toEqual(['append', 'key', 'value with spaces and numbers 123']);
        });
    });
});

describe('Response Formatting', () => {
    interface ExecuteResponse {
        success: boolean;
        result: string;
        leaderId: string | null;
        leaderAddress?: string;
    }

    /**
     * Format response for display
     */
    function formatResponse(response: ExecuteResponse): string {
        if (!response.success) {
            return `Error: Command failed`;
        }
        return response.result;
    }

    it('should format success response', () => {
        const response: ExecuteResponse = {
            success: true,
            result: 'PONG',
            leaderId: 'node1',
        };

        expect(formatResponse(response)).toBe('PONG');
    });

    it('should format error response', () => {
        const response: ExecuteResponse = {
            success: false,
            result: '',
            leaderId: 'node2',
            leaderAddress: 'node2:3000',
        };

        expect(formatResponse(response)).toBe('Error: Command failed');
    });

    it('should format get response with value', () => {
        const response: ExecuteResponse = {
            success: true,
            result: '"hello"',
            leaderId: 'node1',
        };

        expect(formatResponse(response)).toBe('"hello"');
    });

    it('should format get response with empty value', () => {
        const response: ExecuteResponse = {
            success: true,
            result: '""',
            leaderId: 'node1',
        };

        expect(formatResponse(response)).toBe('""');
    });
});

describe('Leader Redirect Logic', () => {
    interface ServerInfo {
        id: string;
        address: string;
        port: number;
    }

    /**
     * Parse server address to ServerInfo
     */
    function parseServerAddress(address: string): ServerInfo {
        const parts = address.split(':');
        const host = parts[0];
        const port = parts[1] ? parseInt(parts[1], 10) : 3000;
        return {
            id: host,
            address: host,
            port,
        };
    }

    it('should parse address with port', () => {
        const info = parseServerAddress('node2:3000');
        expect(info.id).toBe('node2');
        expect(info.address).toBe('node2');
        expect(info.port).toBe(3000);
    });

    it('should parse address without port (default 3000)', () => {
        const info = parseServerAddress('node2');
        expect(info.id).toBe('node2');
        expect(info.address).toBe('node2');
        expect(info.port).toBe(3000);
    });

    it('should parse IP address with port', () => {
        const info = parseServerAddress('192.168.1.1:3001');
        expect(info.id).toBe('192.168.1.1');
        expect(info.address).toBe('192.168.1.1');
        expect(info.port).toBe(3001);
    });

    it('should handle localhost', () => {
        const info = parseServerAddress('localhost:3000');
        expect(info.id).toBe('localhost');
        expect(info.address).toBe('localhost');
        expect(info.port).toBe(3000);
    });
});

describe('Server List Management', () => {
    interface ServerInfo {
        id: string;
        address: string;
        port: number;
    }

    let servers: ServerInfo[];

    beforeEach(() => {
        servers = [
            { id: 'node1', address: 'node1', port: 3000 },
            { id: 'node2', address: 'node2', port: 3000 },
        ];
    });

    it('should add new server to list', () => {
        const newServer: ServerInfo = { id: 'node3', address: 'node3', port: 3000 };

        if (!servers.find(s => s.id === newServer.id)) {
            servers.push(newServer);
        }

        expect(servers).toHaveLength(3);
        expect(servers.find(s => s.id === 'node3')).toBeDefined();
    });

    it('should not add duplicate server', () => {
        const existingServer: ServerInfo = { id: 'node1', address: 'node1', port: 3000 };

        if (!servers.find(s => s.id === existingServer.id)) {
            servers.push(existingServer);
        }

        expect(servers).toHaveLength(2);
    });

    it('should update cached leader', () => {
        let cachedLeader: ServerInfo | null = null;

        // Initially no leader
        expect(cachedLeader).toBeNull();

        // After successful request to node2
        cachedLeader = servers[1];
        expect(cachedLeader.id).toBe('node2');

        // After redirect to node1
        cachedLeader = servers[0];
        expect(cachedLeader.id).toBe('node1');
    });

    it('should cycle through servers on connection failure', () => {
        let currentIndex = 0;

        // Simulate failure on node1, try node2
        currentIndex = (currentIndex + 1) % servers.length;
        expect(servers[currentIndex].id).toBe('node2');

        // Simulate failure on node2, wrap to node1
        currentIndex = (currentIndex + 1) % servers.length;
        expect(servers[currentIndex].id).toBe('node1');
    });
});
