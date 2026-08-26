const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SerialPort } = require('serialport');

const BOOTLOADER_VID = 0x303a;
const BOOTLOADER_PID = 0x1001;
const FLASH_BAUDRATE = 115200;
const FLASH_MODE = 'dio';
const FLASH_FREQ = '40m';
const FLASH_SIZE = '4MB';
const FIRMWARE_FILE_MAP = {
    firmwarez1: 'ooznest-workbee-z1plus.bin',
    firmwarez2: 'ooznest-workbee-z2plus.bin',
    firmwareactuator: 'ooznest-actuator.bin'
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUsbId(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const cleaned = value.trim().replace(/^0x/i, '');
        if (!cleaned) return undefined;
        return Number.parseInt(cleaned, 16);
    }
    return undefined;
}

class NodeSerialDevice {
    constructor(pathName, info = {}) {
        this.pathName = pathName;
        this.info = info;
        this._queue = [];
        this._pendingReads = [];
        this._closed = false;
        this._readerActive = false;
        this._writerActive = false;
        this._currentDtr = false;
        this._port = null;

        this.readable = {
            get locked() {
                return this._lockedRef();
            },
            getReader: () => this._createReader(),
            _lockedRef: () => this._readerActive
        };

        this.writable = {
            get locked() {
                return this._lockedRef();
            },
            getWriter: () => this._createWriter(),
            _lockedRef: () => this._writerActive
        };
    }

    getInfo() {
        return {
            usbVendorId: parseUsbId(this.info.vendorId ?? this.info.usbVendorId),
            usbProductId: parseUsbId(this.info.productId ?? this.info.usbProductId)
        };
    }

    async open(options = {}) {
        if (this._port?.isOpen) {
            await this.close();
        }

        this._closed = false;
        this._queue = [];
        this._pendingReads = [];
        this._port = new SerialPort({
            path: this.pathName,
            baudRate: options.baudRate || FLASH_BAUDRATE,
            dataBits: options.dataBits,
            stopBits: options.stopBits,
            parity: options.parity || 'none',
            autoOpen: false
        });

        this._port.on('data', (chunk) => {
            const data = Uint8Array.from(chunk);
            if (this._pendingReads.length) {
                const resolve = this._pendingReads.shift();
                resolve({ value: data, done: false });
            } else {
                this._queue.push(data);
            }
        });

        this._port.on('close', () => {
            this._closed = true;
            while (this._pendingReads.length) {
                const resolve = this._pendingReads.shift();
                resolve({ value: undefined, done: true });
            }
        });

        this._port.on('error', (error) => {
            while (this._pendingReads.length) {
                const resolve = this._pendingReads.shift();
                resolve(Promise.reject(error));
            }
        });

        await new Promise((resolve, reject) => {
            this._port.open((error) => error ? reject(error) : resolve());
        });
    }

    async close() {
        if (!this._port) return;
        const port = this._port;
        this._port = null;
        this._closed = true;

        if (port.isOpen) {
            await new Promise((resolve) => {
                port.close(() => resolve());
            });
        }

        while (this._pendingReads.length) {
            const resolve = this._pendingReads.shift();
            resolve({ value: undefined, done: true });
        }
    }

    async setSignals(signals = {}) {
        if (!this._port?.isOpen) return;
        if (typeof signals.dataTerminalReady === 'boolean') {
            this._currentDtr = signals.dataTerminalReady;
        }
        await new Promise((resolve, reject) => {
            this._port.set({
                dtr: typeof signals.dataTerminalReady === 'boolean' ? signals.dataTerminalReady : this._currentDtr,
                rts: typeof signals.requestToSend === 'boolean' ? signals.requestToSend : undefined
            }, (error) => error ? reject(error) : resolve());
        });
    }

    _createReader() {
        this._readerActive = true;
        return {
            read: () => {
                if (this._queue.length) {
                    return Promise.resolve({ value: this._queue.shift(), done: false });
                }
                if (this._closed) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => this._pendingReads.push(resolve));
            },
            cancel: async () => {
                this._closed = true;
                while (this._pendingReads.length) {
                    const resolve = this._pendingReads.shift();
                    resolve({ value: undefined, done: true });
                }
            },
            releaseLock: () => {
                this._readerActive = false;
            }
        };
    }

    _createWriter() {
        this._writerActive = true;
        return {
            write: (data) => new Promise((resolve, reject) => {
                if (!this._port?.isOpen) {
                    reject(new Error('Port is not open'));
                    return;
                }
                this._port.write(Buffer.from(data), (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    this._port.drain((drainError) => drainError ? reject(drainError) : resolve());
                });
            }),
            close: async () => {},
            releaseLock: () => {
                this._writerActive = false;
            }
        };
    }
}

async function listCandidatePorts() {
    const ports = await SerialPort.list();
    return ports.filter((port) => {
        const pathUpper = (port.path || '').toUpperCase();
        return pathUpper !== 'COM1' && pathUpper !== 'COM2';
    });
}

async function getPortByPath(pathName) {
    if (!pathName) return null;
    const ports = await listCandidatePorts();
    return ports.find((port) => port.path === pathName) || null;
}

async function waitForPort(predicate, timeoutMs = 20000, pollMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const ports = await listCandidatePorts();
        const match = ports.find(predicate);
        if (match) return match;
        await sleep(pollMs);
    }
    return null;
}

async function loadEsptool() {
    return import('esptool-js');
}

async function loadFirmwareImages(baseDir, firmwareKey) {
    const firmwareDir = path.join(baseDir, 'firmware');
    const firmwareFile = FIRMWARE_FILE_MAP[firmwareKey] || `${firmwareKey}.bin`;
    const read = (name) => fs.promises.readFile(path.join(firmwareDir, name));
    return {
        bootloader: Uint8Array.from(await read('bootloader.bin')),
        partitions: Uint8Array.from(await read('partitions.bin')),
        firmware: Uint8Array.from(await read(firmwareFile))
    };
}

async function resetIntoApplication(esploader, transport, log) {
    const isEsp32S3 = esploader?.chip?.CHIP_NAME === 'ESP32-S3';

    if (isEsp32S3) {
        try {
            const RTC_CNTL_OPTION1_REG = 0x6000812C;
            const RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 0x1;
            const RTCCNTL_BASE_REG = 0x60008000;
            const RTC_CNTL_WDTCONFIG0_REG = RTCCNTL_BASE_REG + 0x0098;
            const RTC_CNTL_WDTCONFIG1_REG = RTCCNTL_BASE_REG + 0x009C;
            const RTC_CNTL_WDTWPROTECT_REG = RTCCNTL_BASE_REG + 0x00B0;
            const RTC_CNTL_WDT_WKEY = 0x50D83AA1;
            const RTC_WDT_ENABLE = (1 << 31) | (5 << 28) | (1 << 8) | 2;

            log('[RESET] Clearing ESP32-S3 forced download boot flag...');
            await esploader.writeReg(RTC_CNTL_OPTION1_REG, 0, RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK);
            log('[RESET] Resetting ESP32-S3 via RTC watchdog...');
            await esploader.writeReg(RTC_CNTL_WDTWPROTECT_REG, RTC_CNTL_WDT_WKEY);
            await esploader.writeReg(RTC_CNTL_WDTCONFIG1_REG, 2000);
            await esploader.writeReg(RTC_CNTL_WDTCONFIG0_REG, RTC_WDT_ENABLE);
            await esploader.writeReg(RTC_CNTL_WDTWPROTECT_REG, 0);
            await sleep(800);
            return;
        } catch (error) {
            log(`[RESET] Register reset path failed: ${error?.message || error}`);
        }
    }

    log('[RESET] Resetting via USB Serial/JTAG...');
    const { UsbJtagSerialReset } = await loadEsptool();
    await new UsbJtagSerialReset(transport).reset();
    await sleep(1200);
}

async function runFirmwareFlash({
    baseDir,
    firmwareKey,
    previousPort,
    programmingPort,
    log,
    progress,
    beforeFlashClose
}) {
    if (!previousPort && !programmingPort) {
        throw new Error('No controller or programming port was supplied.');
    }

    if (previousPort && typeof beforeFlashClose === 'function') {
        await beforeFlashClose();
    }

    let flashPort = null;
    if (previousPort) {
        log('[SYSTEM] Waiting for bootloader USB port...');
        const bootloaderPort = await waitForPort((port) =>
            parseUsbId(port.vendorId) === BOOTLOADER_VID && parseUsbId(port.productId) === BOOTLOADER_PID
        );

        if (!bootloaderPort) {
            throw new Error('Timed out waiting for the ESP32 bootloader port.');
        }

        flashPort = bootloaderPort;
        log(`[SYSTEM] Bootloader port detected on ${bootloaderPort.path}`);
    } else {
        flashPort = await getPortByPath(programmingPort);
        if (!flashPort) {
            flashPort = { path: programmingPort };
        }
        log(`[SYSTEM] Using selected programming port ${programmingPort}...`);
    }

    const { ESPLoader, Transport, ClassicReset, HardReset, UsbJtagSerialReset } = await loadEsptool();
    const images = await loadFirmwareImages(baseDir, firmwareKey);
    const device = new NodeSerialDevice(flashPort.path, flashPort);
    const transport = new Transport(device);
    const esploader = new ESPLoader({
        transport,
        baudrate: FLASH_BAUDRATE,
        terminal: {
            clean() {},
            writeLine(data) {
                log(data);
            },
            write(data) {
                log(data);
            }
        },
        resetConstructors: {
            classicReset: (t, d) => new ClassicReset(t, d),
            hardReset: (t, u) => new HardReset(t, u),
            usbJTAGSerialReset: (t) => new UsbJtagSerialReset(t)
        }
    });

    try {
        await esploader.main('no_reset');
        await esploader.writeFlash({
            fileArray: [
                { data: images.bootloader, address: 0x0000 },
                { data: images.partitions, address: 0x8000 },
                { data: images.firmware, address: 0x10000 }
            ],
            flashMode: FLASH_MODE,
            flashFreq: FLASH_FREQ,
            flashSize: FLASH_SIZE,
            compress: true,
            reportProgress: (_index, written, total) => {
                progress(Math.round((written / total) * 100));
            },
            calculateMD5Hash: (img) => crypto.createHash('md5').update(Buffer.from(img)).digest('hex')
        });
        log('[COMPLETE] Device flashed successfully.');
        await resetIntoApplication(esploader, transport, log);
    } finally {
        try {
            await transport.disconnect();
        } catch (_) {
            // Best-effort cleanup after flashing.
        }
    }

    const reconnectTarget = previousPort || programmingPort;
    if (!reconnectTarget) {
        return {};
    }

    log(`[SYSTEM] Waiting for controller port ${reconnectTarget} to return...`);
    const restoredPort = await waitForPort((port) => port.path === reconnectTarget, 30000, 300);
    if (!restoredPort) {
        if (previousPort) {
            throw new Error(`Firmware flashed, but the controller port ${previousPort} did not reappear.`);
        }
        return {};
    }

    return {
        reconnect: {
            port: restoredPort.path,
            baud: FLASH_BAUDRATE
        }
    };
}

module.exports = {
    runFirmwareFlash
};
