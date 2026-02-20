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
            theme: {
                background: '#FFFFFF',
                foreground: '#333333',
                cursor: '#333333',
                selectionBackground: '#D6EAF8',
                selectionInactiveBackground: '#F2F4F8'
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
