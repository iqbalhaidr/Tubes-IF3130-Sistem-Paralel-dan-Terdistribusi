/**
 * Logger Utility Module
 * 
 * Provides structured logging with timestamps and component context.
 * All server actions are logged to the terminal as required by spec.
 * 
 * @module utils/logger
 */

/**
 * Log levels in order of severity
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

/**
 * Color mapping for log levels
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: COLORS.gray,
    [LogLevel.INFO]: COLORS.green,
    [LogLevel.WARN]: COLORS.yellow,
    [LogLevel.ERROR]: COLORS.red,
};

/**
 * Label mapping for log levels
 */
const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO ',
    [LogLevel.WARN]: 'WARN ',
    [LogLevel.ERROR]: 'ERROR',
};

/**
 * Global minimum log level (can be set via environment variable)
 */
let globalLogLevel: LogLevel = LogLevel.DEBUG;

/**
 * Set the global minimum log level
 * 
 * @param level - Minimum level to log
 */
export function setLogLevel(level: LogLevel): void {
    globalLogLevel = level;
}

/**
 * Get the global log level from environment variable
 */
function getLogLevelFromEnv(): LogLevel {
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
        case 'DEBUG': return LogLevel.DEBUG;
        case 'INFO': return LogLevel.INFO;
        case 'WARN': return LogLevel.WARN;
        case 'ERROR': return LogLevel.ERROR;
        default: return LogLevel.DEBUG;
    }
}

// Initialize from environment
globalLogLevel = getLogLevelFromEnv();

/**
 * Format a timestamp for logging
 * 
 * @returns Formatted timestamp string
 */
function formatTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Logger class for structured logging with component context
 * 
 * Usage:
 * ```typescript
 * const logger = new Logger('RaftNode');
 * logger.info('Starting election');
 * logger.debug('Vote count:', voteCount);
 * logger.error('Failed to connect to peer', error);
 * ```
 */
export class Logger {
    private component: string;
    private nodeId: string | null = null;

    /**
     * Create a new logger instance
     * 
     * @param component - Component name for context
     */
    constructor(component: string) {
        this.component = component;
    }

    /**
     * Set the node ID for this logger (adds context to all logs)
     * 
     * @param nodeId - Node identifier
     */
    setNodeId(nodeId: string): void {
        this.nodeId = nodeId;
    }

    /**
     * Format and output a log message
     * 
     * @param level - Log level
     * @param args - Message arguments
     */
    private log(level: LogLevel, ...args: any[]): void {
        if (level < globalLogLevel) {
            return;
        }

        const timestamp = formatTimestamp();
        const color = LEVEL_COLORS[level];
        const label = LEVEL_LABELS[level];
        const nodeContext = this.nodeId ? `[${this.nodeId}]` : '';
        const prefix = `${COLORS.gray}${timestamp}${COLORS.reset} ${color}${label}${COLORS.reset} ${COLORS.cyan}[${this.component}]${COLORS.reset}${nodeContext}`;

        // Format the message
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        console.log(`${prefix} ${message}`);
    }

    /**
     * Log a debug message (for detailed troubleshooting)
     */
    debug(...args: any[]): void {
        this.log(LogLevel.DEBUG, ...args);
    }

    /**
     * Log an info message (for normal operations)
     */
    info(...args: any[]): void {
        this.log(LogLevel.INFO, ...args);
    }

    /**
     * Log a warning message (for potential issues)
     */
    warn(...args: any[]): void {
        this.log(LogLevel.WARN, ...args);
    }

    /**
     * Log an error message (for failures)
     */
    error(...args: any[]): void {
        this.log(LogLevel.ERROR, ...args);
    }

    /**
     * Log a state transition (for Raft state changes)
     */
    stateChange(from: string, to: string, reason: string): void {
        this.info(`State transition: ${COLORS.magenta}${from}${COLORS.reset} -> ${COLORS.green}${to}${COLORS.reset} (${reason})`);
    }

    /**
     * Log an RPC event
     */
    rpc(direction: 'IN' | 'OUT', method: string, peer: string, details?: string): void {
        const arrow = direction === 'IN' ? '<<' : '>>';
        const detailStr = details ? ` - ${details}` : '';
        this.debug(`RPC ${arrow} ${method} [${peer}]${detailStr}`);
    }
}

/**
 * Create a child logger with additional context
 * 
 * @param parent - Parent logger
 * @param subComponent - Sub-component name
 * @returns New logger with combined context
 */
export function createChildLogger(parent: Logger, subComponent: string): Logger {
    return new Logger(`${(parent as any).component}:${subComponent}`);
}
