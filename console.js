// Console Module
// Handles terminal/console functionality, command history, and input

class ConsoleManager {
    constructor() {
        this.term = null;
        this.fitAddon = null;
        this.commandHistory = [];
        this.historyIndex = 0;
    }

    /**
     * Initialize the terminal
     */
    initTerminal() {
        this.term = new Terminal({
            cursorBlink: true,
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            rightClickSelectsWord: true,
            minimumContrastRatio: 1,   /* Disable auto-contrast: xterm 5.x reads DOM bg color which may be white from sidebar CSS, then shifts all text towards white making it invisible */
            theme: {
                background: '#B0CACF', // oz-teal-light
                foreground: '#0D1F22', // oz-black
                cursor: '#449D9F',
                selectionBackground: 'rgba(68, 157, 159, 0.4)',
                black: '#0D1F22',
                red: '#dc2626',
                green: '#16a34a',
                yellow: '#d97706',
                blue: '#2563eb',
                magenta: '#9333ea',
                cyan: '#0891b2',
                white: '#475569',
                brightBlack: '#334155',
                brightRed: '#ef4444',
                brightGreen: '#22c55e',
                brightYellow: '#f59e0b',
                brightBlue: '#3b82f6',
                brightMagenta: '#a855f7',
                brightCyan: '#06b6d4',
                brightWhite: '#94a3b8'
            }
        });

        this.term.attachCustomKeyEventHandler((arg) => {
            if (arg.ctrlKey && arg.code === "KeyC" && this.term.hasSelection()) return false;
            return true;
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(document.getElementById('terminal-container'));
        this.fitAddon.fit();

        // Expose globally for other modules
        window.term = this.term;
        window.fitAddon = this.fitAddon;
    }

    /**
     * Send command from input field
     */
    sendFromInput() {
        const i = document.getElementById('cmdInput');
        const val = i.value.trim();
        if (val) {
            if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== val) {
                this.commandHistory.push(val);
                if (this.commandHistory.length > 50) this.commandHistory.shift();
            }
            this.historyIndex = this.commandHistory.length;

            if (val === '?' || val === '$G') {
                window.userRequestedStatus = true;
            }

            window.sendCmd(val);
            i.value = '';
        }
    }

    /**
     * Navigate command history
     * @param {number} direction - -1 for up, 1 for down
     */
    navigateHistory(direction) {
        if (this.commandHistory.length === 0) return;
        this.historyIndex += direction;
        if (this.historyIndex < 0) this.historyIndex = 0;
        if (this.historyIndex > this.commandHistory.length) this.historyIndex = this.commandHistory.length;
        const input = document.getElementById('cmdInput');
        if (this.historyIndex < this.commandHistory.length) {
            input.value = this.commandHistory[this.historyIndex];
        } else {
            input.value = '';
        }
    }

    /**
     * Setup console input event listeners
     */
    setupInputListeners() {
        document.getElementById('btnSend').addEventListener('click', () => this.sendFromInput());

        document.getElementById('cmdInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.sendFromInput();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateHistory(-1);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateHistory(1);
            }
        });
    }
}

// Export singleton instance
window.consoleManager = new ConsoleManager();

// Expose global functions for compatibility
window.sendFromInput = () => window.consoleManager.sendFromInput();
