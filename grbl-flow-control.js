/**
 * grbl-flow-control.js
 * Implements Grbl v1.1 character-counting flow control.
 */
export class GrblFlowControl {
    constructor(transport) {
        this.transport = transport; // Must have writeRaw(data)

        this._rxBufSize = 128;
        this._rxBufUsed = 0;
        this._pendingLens = [];
        this._sendQueue = [];
        this.encoder = new TextEncoder();
    }

    reset() {
        this._rxBufUsed = 0;
        this._pendingLens = [];
        const queue = this._sendQueue;
        this._sendQueue = [];
        queue.forEach(item => item.reject(new Error('Connection reset')));
    }

    async sendCommand(line) {
        const bytes = this.encoder.encode(line + '\n');
        const len = bytes.length;

        if (this._rxBufUsed + len >= this._rxBufSize) {
            await new Promise((resolve, reject) => {
                this._sendQueue.push({ len, resolve, reject });
            });
        } else {
            this._rxBufUsed += len;
            this._pendingLens.push(len);
        }

        await this.transport.writeRaw(bytes);
    }

    processLine(line) {
        if (line === 'ok' || line.startsWith('error:')) {
            const len = this._pendingLens.shift();
            if (len !== undefined) {
                this._rxBufUsed -= len;
                this._flushSendQueue();
            }
        }
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
                break;
            }
        }
    }
}
