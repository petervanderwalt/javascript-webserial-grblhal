/**
 * webserial.js - Web Serial API wrapper with Grbl v1.1 character-counting flow control.
 *
 * Flow control protocol (from https://github.com/gnea/grbl/wiki/Grbl-v1.1-Interface):
 *   - grblHAL has a 128-byte serial RX buffer.
 *   - The host tracks how many characters have been sent but not yet acknowledged.
 *   - Before sending a command, the host checks: charCount + cmdLen < RX_BUF_SIZE
 *   - Each 'ok' or 'error:N' response frees the space used by the oldest pending command.
 *   - Realtime characters (?, !, ~, 0x18, 0x84..0x8F) bypass the buffer tracking entirely.
 */

export class WebSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.isConnected = false;

        // Event listeners
        this.listeners = {
            connect: [],
            disconnect: [],
            line: [],
            raw: [],
            sent: [],
            error: []
        };

        this.rawModeCallback = null;

        // --- Grbl v1.1 Character-Counting Flow Control ---
        this._rxBufSize = 128;    // grblHAL serial RX buffer size
        this._rxBufUsed = 0;      // Bytes currently occupying grblHAL's RX buffer
        this._pendingLens = [];   // FIFO of command byte-lengths awaiting ok/error
        this._sendQueue = [];     // Commands waiting for buffer space: {len, bytes, resolve, reject}

        // Internal flow-control listener - registered first so it fires before UI listeners
        this._onLine = (line) => {
            if (line === 'ok' || line.startsWith('error:')) {
                const len = this._pendingLens.shift();
                if (len !== undefined) {
                    this._rxBufUsed -= len;
                    this._flushSendQueue();
                }
            }
        };
        this.on('line', this._onLine);
    }

    // ---- Flow Control Helpers ----

    _resetFlowControl() {
        this._rxBufUsed = 0;
        this._pendingLens = [];
        const queue = this._sendQueue;
        this._sendQueue = [];
        queue.forEach(item => item.reject(new Error('Connection reset')));
    }

    _flushSendQueue() {
        while (this._sendQueue.length > 0) {
            const item = this._sendQueue[0];
            if (this._rxBufUsed + item.len < this._rxBufSize) {
                this._sendQueue.shift();
                this._rxBufUsed += item.len;
                this._pendingLens.push(item.len);
                item.resolve();
            } else {
                break; // Next item still doesn't fit
            }
        }
    }

    // ---- Public API ----

    on(event, callback) {
        if (this.listeners[event]) this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    async connect(baudRate = 115200) {
        if (!navigator.serial) {
            const err = new Error('Web Serial is not supported in this browser.');
            this.emit('error', err);
            throw err;
        }
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate });
            this._resetFlowControl();
            this.isConnected = true;
            this.listeners.connect.forEach(cb => cb());
            this.readLoop();
        } catch (err) {
            console.error('Serial Connect Error:', err);
            if (err.name !== 'NotFoundError') this.emit('error', err);
            throw err;
        }
    }

    async disconnect() {
        if (!this.isConnected && !this.port) return;
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this._resetFlowControl();

        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (e) {
                    console.debug('WebSerial: reader cancel (expected):', e);
                }
                this.reader = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (e) {
                    console.debug('WebSerial: port close (expected):', e);
                }
                this.port = null;
            }
        } finally {
            if (wasConnected) this.emit('disconnect');
        }
    }

    /**
     * Send a G-code or system command with character-counting flow control.
     * Waits if grblHAL's RX buffer would overflow.
     */
    async sendCommand(line) {
        const bytes = this.encoder.encode(line + '\n');
        const len = bytes.length;

        // Block until there is room in grblHAL's RX buffer
        if (this._rxBufUsed + len >= this._rxBufSize) {
            await new Promise((resolve, reject) => {
                this._sendQueue.push({ len, resolve, reject });
            });
            // Space was claimed by _flushSendQueue when it resolved us
        } else {
            // Claim space immediately
            this._rxBufUsed += len;
            this._pendingLens.push(len);
        }

        if (!this.isConnected) return;

        await this.writeRaw(bytes);
        this.listeners.sent.forEach(cb => cb(line));
    }

    /**
     * Send a single realtime command byte.
     * These are intercepted by grblHAL before entering its line buffer,
     * so they do NOT count toward the RX buffer usage.
     */
    async sendRealtime(char) {
        const data = this.encoder.encode(char);
        await this.writeRaw(data);
    }

    /**
     * Low-level write with lock-retry (original proven approach).
     */
    async writeRaw(data) {
        if (!this.port || !this.port.writable) return;

        let retries = 0;
        while (this.port.writable.locked && retries < 20) {
            await new Promise(r => setTimeout(r, 10));
            retries++;
        }

        if (this.port.writable.locked) {
            console.warn('Serial write dropped: stream still locked after retries');
            return;
        }

        const writer = this.port.writable.getWriter();
        try {
            await writer.write(data);
        } catch (e) {
            console.error('Serial Write Error:', e);
            this.emit('error', e);
        } finally {
            writer.releaseLock();
        }
    }

    setRawHandler(callback) {
        this.rawModeCallback = callback;
    }

    async readLoop() {
        this.reader = this.port.readable.getReader();

        const onDisconnect = (event) => {
            if (event.port === this.port) {
                console.warn('WebSerial: hardware device disconnected.');
                this.disconnect();
            }
        };
        navigator.serial.addEventListener('disconnect', onDisconnect);

        try {
            let textBuffer = '';
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    if (this.rawModeCallback) {
                        this.rawModeCallback(value);
                        continue;
                    }
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
            console.error('WebSerial Read Error:', err);
            if (this.isConnected) {
                this.emit('error', new Error('Connection lost: ' + err.message));
                this.disconnect();
            }
        } finally {
            if (this.reader) {
                try { this.reader.releaseLock(); } catch (e) { }
                this.reader = null;
            }
            navigator.serial.removeEventListener('disconnect', onDisconnect);
        }
    }
}
