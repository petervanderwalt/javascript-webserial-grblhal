/**
 * webserial.js - A robust wrapper for the Web Serial API.
 */

export class WebSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.isConnected = false;

        // Event listeners storage
        this.listeners = {
            connect: [],
            disconnect: [],
            line: [], // Standard text lines received
            raw: [],  // Raw Uint8Array chunks (for YMODEM)
            sent: [],  // Commands sent (for UI echo)
            error: [] // New: Error reporting
        };

        // If set, this function receives raw bytes instead of the text decoder
        this.rawModeCallback = null;
    }

    /**
     * Subscribe to an event.
     * @param {string} event - 'connect', 'disconnect', 'line', 'raw', 'sent', 'error'
     * @param {function} callback
     */
    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    /**
     * Request user to select a port and open it.
     * @param {number} baudRate
     */
    async connect(baudRate = 115200) {
        if (!navigator.serial) {
            const err = new Error("Web Serial is not supported in this browser.");
            this.emit('error', err);
            throw err;
        }

        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: baudRate });

            this.isConnected = true;
            this.listeners.connect.forEach(cb => cb());

            // Start the read loop
            this.readLoop();
        } catch (err) {
            console.error("Serial Connect Error:", err);
            // Ignore "NotFoundError" which happens when user clicks 'Cancel' in the browser dialog
            if (err.name !== 'NotFoundError') {
                this.emit('error', err);
            }
            throw err;
        }
    }

    /**
     * Close the port and cleanup.
     */
    async disconnect() {
        if (!this.isConnected && !this.port) return;

        // Reset state immediately to prevent re-entry/double-calls
        const wasConnected = this.isConnected;
        this.isConnected = false;

        try {
            if (this.reader) {
                try {
                    // Try to cancel the reader, but don't hang if it's already in a bad state
                    await this.reader.cancel();
                } catch (e) {
                    console.debug("WebSerial: Error canceling reader during disconnect (expected if device lost):", e);
                }
                this.reader = null;
            }
            if (this.port) {
                try {
                    await this.port.close();
                } catch (e) {
                    console.debug("WebSerial: Error closing port during disconnect (expected if device lost):", e);
                }
                this.port = null;
            }
        } finally {
            if (wasConnected) {
                this.emit('disconnect');
            }
        }
    }

    /**
     * Send text data (automatically encodes to bytes).
     * @param {string} text - String to send
     */
    async write(text) {
        const data = this.encoder.encode(text);
        await this.writeRaw(data);
    }

    /**
     * Send a line of G-code (appends \n) and emits 'sent' event.
     * @param {string} line
     */
    async sendCommand(line) {
        await this.write(line + '\n');
        this.listeners.sent.forEach(cb => cb(line));
    }

    /**
     * Send a single realtime character (no newline).
     * @param {string} char
     */
    async sendRealtime(char) {
        await this.write(char);
    }

    /**
     * Low-level write function with locking/retry logic.
     * @param {Uint8Array} data
     */
    async writeRaw(data) {
        if (!this.isConnected || !this.port || !this.port.writable) return;

        // Wait if the writer is locked (e.g., by another ongoing write)
        let retries = 0;
        try {
            while (this.port.writable.locked && retries < 20) {
                await new Promise(r => setTimeout(r, 10)); // Wait 10ms
                retries++;
            }
        } catch (e) {
            this.disconnect();
            return;
        }

        if (this.port.writable.locked) {
            console.warn("Serial write dropped: Stream locked");
            return;
        }

        const writer = this.port.writable.getWriter();
        try {
            await writer.write(data);
        } catch (e) {
            console.error("Serial Write Error:", e);
            // If we hit a network or state error during write, the port is likely dead
            if (e.name === 'NetworkError' || e.name === 'InvalidStateError') {
                this.disconnect();
            }
        } finally {
            try {
                writer.releaseLock();
            } catch (e) { }
        }
    }

    /**
     * Enable/Disable Raw Mode for binary protocols like YMODEM.
     * @param {function|null} callback - Function to handle Uint8Array, or null to disable.
     */
    setRawHandler(callback) {
        this.rawModeCallback = callback;
    }

    /**
     * Internal Read Loop
     */
    async readLoop() {
        this.reader = this.port.readable.getReader();

        // Listen for device removal at the browser level
        const onDisconnect = (event) => {
            if (event.port === this.port) {
                console.warn("WebSerial: Hardware device disconnected.");
                this.disconnect();
            }
        };
        navigator.serial.addEventListener('disconnect', onDisconnect);

        try {
            let textBuffer = "";
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    // 1. Raw Mode (YMODEM)
                    if (this.rawModeCallback) {
                        this.rawModeCallback(value);
                        continue;
                    }

                    // 2. Text Mode (Grbl)
                    const chunk = this.decoder.decode(value, { stream: true });
                    textBuffer += chunk;

                    const lines = textBuffer.split('\n');
                    textBuffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed) this.emit('line', trimmed);
                    }
                }
            }
        } catch (err) {
            console.error("WebSerial Read Error:", err);
            if (this.isConnected) {
                this.emit('error', new Error("Connection lost: " + err.message));
                // We call disconnect, but the finally block will release the reader lock first
                this.disconnect();
            }
        } finally {
            if (this.reader) {
                try {
                    this.reader.releaseLock();
                } catch (e) { }
                this.reader = null;
            }
            navigator.serial.removeEventListener('disconnect', onDisconnect);
        }
    }
}
