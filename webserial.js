

/**
 * webserial.js - A robust wrapper for the Web Serial API.
 *
 * Features:
 * - Manages connection/disconnection state.
 * - robustWrite: Handles WriteStream locking and retries automatically.
 * - Read Loop: Automatically decodes text into lines.
 * - Raw Mode: Allows hijacking the read stream for binary protocols (YMODEM).
 * - Event System: Subscribe to 'connect', 'disconnect', 'line', 'raw', or 'sent'.
 *
 * Usage:
 *   const serial = new WebSerial();
 *   serial.on('line', (line) => console.log(line));
 *   await serial.connect(115200);
 *   serial.write("G0 X10\n");
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
            sent: []  // Commands sent (for UI echo)
        };

        // If set, this function receives raw bytes instead of the text decoder
        this.rawModeCallback = null;
    }

    /**
     * Subscribe to an event.
     * @param {string} event - 'connect', 'disconnect', 'line', 'raw', 'sent'
     * @param {function} callback
     */
    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }

    /**
     * Request user to select a port and open it.
     * @param {number} baudRate
     */
    async connect(baudRate = 115200) {
        if (!navigator.serial) throw new Error("Web Serial not supported");

        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: baudRate });

            this.isConnected = true;
            this.listeners.connect.forEach(cb => cb());

            // Start the read loop
            this.readLoop();
        } catch (err) {
            console.error("Serial Connect Error:", err);
            throw err;
        }
    }

    /**
     * Close the port and cleanup.
     */
    async disconnect() {
        if (this.reader) {
            await this.reader.cancel();
            this.reader = null;
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        this.isConnected = false;
        this.listeners.disconnect.forEach(cb => cb());
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
        if (!this.port || !this.port.writable) return;

        // Wait if the writer is locked (e.g., by another ongoing write)
        let retries = 0;
        while (this.port.writable.locked && retries < 20) {
            await new Promise(r => setTimeout(r, 10)); // Wait 10ms
            retries++;
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
        } finally {
            writer.releaseLock();
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
        let textBuffer = "";

        try {
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
                    textBuffer = lines.pop(); // Keep partial line in buffer

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed) {
                            this.listeners.line.forEach(cb => cb(trimmed));
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Read Error:", err);
            this.disconnect();
        } finally {
            this.reader.releaseLock();
        }
    }
}
