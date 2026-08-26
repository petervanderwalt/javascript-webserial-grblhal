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
        this._writeLock = Promise.resolve();
        this._readBuffer = '';

        // --- Grbl v1.1 Character-Counting Flow Control (OpenBuilds pattern) ---
        this.rxBufSize = 128;
        this.sentBuffer = [];
        // Pop sentBuffer on ok/error (must be registered before UI listeners)
        this._onLine = (line) => {
            if (line === 'ok' || line.startsWith('error:')) {
                this.sentBuffer.shift();
            }
        };
        this.on('line', this._onLine);
    }

    // ---- Flow Control Helpers ----

    bufferSpace() {
        let total = 0;
        for (let i = 0; i < this.sentBuffer.length; i++) {
            total += this.sentBuffer[i].length;
        }
        return (this.rxBufSize - 1) - total;
    }

    canSend(line) {
        return line.length < this.bufferSpace();
    }

    isDrained() {
        return this.sentBuffer.length === 0;
    }

    _resetFlowControl() {
        this.sentBuffer = [];
    }

    clearPendingState() {
        this._resetFlowControl();
        this._readBuffer = '';
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
            const port = await navigator.serial.requestPort();
            await this.connectToPort(port, baudRate);
        } catch (err) {
            console.error('Serial Connect Error:', err);
            if (err.name !== 'NotFoundError') this.emit('error', err);
            throw err;
        }
    }

    async connectToPort(port, baudRate = 115200) {
        this.port = port;
        await this.port.open({ baudRate });
        this.clearPendingState();
        this.isConnected = true;
        this.listeners.connect.forEach(cb => cb());
        this.readLoop();
    }

    async disconnect() {
        if (!this.isConnected && !this.port) return;
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.clearPendingState();

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
     * Uses synchronous buffer tracking (OpenBuilds sentBuffer pattern).
     */
    async sendCommand(line) {
        const bytes = this.encoder.encode(line + '\n');
        this.sentBuffer.push(line);

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
     * Low-level write with Promise-based Mutex queue.
     * Prevents lock assertion failures and prevents data dropout under load.
     */
    async writeRaw(data) {
        if (!this.port || !this.port.writable) return;

        // Chain the new write onto the existing promise chain
        const writePromise = this._writeLock.then(async () => {
            if (!this.port || !this.port.writable) return;
            const writer = this.port.writable.getWriter();
            try {
                await writer.write(data);
            } catch (e) {
                console.error('Serial Write Error:', e);
                this.emit('error', e);
            } finally {
                writer.releaseLock();
            }
        });

        // Update the lock to point to this new promise, catch errors so chain doesn't break
        this._writeLock = writePromise.catch(() => { });

        // Wait for this specific write to finish
        await writePromise;
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
            this._readBuffer = '';
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    if (this.rawModeCallback) {
                        this.rawModeCallback(value);
                        continue;
                    }
                    const chunk = this.decoder.decode(value, { stream: true });
                    this._readBuffer += chunk;
                    const lines = this._readBuffer.split('\n');
                    this._readBuffer = lines.pop();
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
            this._readBuffer = '';
            if (this.reader) {
                try { this.reader.releaseLock(); } catch (e) { }
                this.reader = null;
            }
            navigator.serial.removeEventListener('disconnect', onDisconnect);
        }
    }
}
