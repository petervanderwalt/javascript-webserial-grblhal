import { registerModal } from './modal.js';
import { ESPLoader, Transport, ClassicReset, HardReset, UsbJtagSerialReset } from './vendor/esptool-js.bundle.js';

const BOOTLOADER_COMMAND = '$bootloader';
const BOOTLOADER_MESSAGE = '[MSG:Warning: Entering ESP32 Bootloader]';
const BOOTLOADER_FILTERS = [{ usbVendorId: 0x303a, usbProductId: 0x1001 }];
const FIRMWARE_SERIAL_BAUDRATE = 115200;
const DEFAULT_FLASH_BAUDRATE = 115200;
const FLASH_MODE = 'dio';
const FLASH_FREQ = '40m';
const FLASH_SIZE = '4MB';
const RESET_DELAY_MS = 1200;

const FIRMWARE_OPTIONS = [
    { key: 'firmwarez1', label: 'WorkBee Z1+', fileName: 'ooznest-workbee-z1plus.bin' },
    { key: 'firmwarez2', label: 'WorkBee Z2', fileName: 'ooznest-workbee-z2plus.bin' },
    { key: 'firmwareactuator', label: 'Actuator System', fileName: 'ooznest-actuator.bin' }
];

export class FirmwareFlasher {
    constructor(ws) {
        this.ws = ws;
        this.modal = registerModal('firmware-flasher-overlay', { closeOnBackdrop: true, closeOnEscape: true });
        this.selectedFirmware = FIRMWARE_OPTIONS[0].key;
        this.selectionLocked = false;
        this.busy = false;
        this.progress = 0;
        this.logLines = [];
        this.browserReconnectPending = false;
        this.previousConnection = null;
        this._connectListener = null;
        this._lastBackendEvent = null;
        this._expectedDisconnectUntil = 0;
        this._browserReconnectAttempted = false;
        this._reconnectSucceeded = false;
        this.programmingPortSelectionOpen = false;
        this.availableProgrammingPorts = [];
        this.selectedProgrammingPort = null;

        if (this.ws?.on) {
            this.ws.on('ports', (ports) => this._handleProgrammingPorts(ports));
        }
    }

    showModal(options = {}) {
        if (!this.busy) {
            this._resetSession();
            if (options.firmwareKey) {
                this.selectedFirmware = options.firmwareKey;
            }
            this.selectionLocked = !!options.lockSelection;
            this.onFlashComplete = typeof options.onFlashComplete === 'function' ? options.onFlashComplete : null;
        }
        if (!this.ws?.isConnected) {
            this.availableProgrammingPorts = [];
        }
        this._render();
        this.modal?.show();
    }

    _resetSession() {
        this.selectedFirmware = FIRMWARE_OPTIONS[0].key;
        this.selectionLocked = false;
        this.progress = 0;
        this.logLines = [];
        this.browserReconnectPending = false;
        this.previousConnection = null;
        this._lastBackendEvent = null;
        this._expectedDisconnectUntil = 0;
        this._browserReconnectAttempted = false;
        this._reconnectSucceeded = false;
        this.programmingPortSelectionOpen = false;
        this.availableProgrammingPorts = [];
        this.selectedProgrammingPort = null;
        this.onFlashComplete = null;
        this._completionNotified = false;
    }

    hideModal() {
        if (this.busy) return;
        this.modal?.hide();
    }

    _render() {
        const body = document.getElementById('firmware-flasher-body');
        const footer = document.getElementById('firmware-flasher-footer');
        if (!body || !footer) return;

        let html = '';

        if (window.cordova) {
            html += this._renderStepIndicator();
            html += '<div class="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">';
            html += '<i data-lucide="triangle-alert" style="width:14px;height:14px"></i>';
            html += '<p class="text-xs text-amber-700">Firmware flashing is only available on your computer. Please use Ooznest Control on desktop.</p>';
            html += '</div>';
            body.innerHTML = html;
            footer.innerHTML = '<button class="btn btn-secondary" data-modal-close>Close</button>';
            footer.classList.remove('hidden');
            if (window.lucide) window.lucide.createIcons();
            return;
        }

        html += this._renderStepIndicator();
        html += '<p class="text-sm text-grey mb-4">Select the firmware to install:</p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div>';
        FIRMWARE_OPTIONS.forEach((option) => {
            const sel = this.selectedFirmware === option.key;
            const lockedClass = this.selectionLocked
                ? (sel ? 'cursor-default' : 'cursor-not-allowed opacity-50')
                : 'cursor-pointer';
            html += `<div class="firmware-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors ${lockedClass}" data-value="${option.key}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${option.label}</span>`;
            html += '</div>';
        });
        html += '</div></div>';

        html += '<div class="mt-4 bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div class="px-4 py-2.5 border-b border-grey-light flex items-center justify-between gap-4">';
        html += '<span class="text-[10px] font-bold text-grey-dark uppercase tracking-wider">Flash Progress</span>';
        html += `<span id="firmware-flasher-progress-label" class="text-[10px] font-bold text-grey-dark uppercase tracking-wider">${this.progress}%</span>`;
        html += '</div>';
        html += '<div class="px-4 py-3 bg-grey-bg/30">';
        html += '<div class="h-2 rounded-full bg-grey-light overflow-hidden">';
        html += `<div id="firmware-flasher-progress-bar" class="h-full bg-primary transition-all" style="width:${this.progress}%"></div>`;
        html += '</div>';
        html += '</div>';
        html += '</div>';

        html += '<div class="mt-3" style="height:8rem; max-height:8rem;">';
        html += '<div id="firmware-flasher-log" class="block h-full overflow-y-auto text-[11px] leading-relaxed text-grey-dark font-mono px-1 py-1 bg-transparent border-0"></div>';
        html += '</div>';

        if (!this.ws?.isConnected && window.electron && this.programmingPortSelectionOpen) {
            html += '<div class="mt-4 p-3 bg-white rounded-xl border border-grey-light">';
            html += '<p class="text-xs font-bold text-grey-dark uppercase tracking-wider mb-2">Programming Port</p>';
            html += '<select id="firmware-flasher-programming-port" class="ooznest-select oz-select w-full">';
            if (this.availableProgrammingPorts.length) {
                html += '<option value="">Select a port...</option>';
                this.availableProgrammingPorts.forEach((port) => {
                    const label = port.friendlyName || port.path;
                    const selected = this.selectedProgrammingPort === port.path ? ' selected' : '';
                    html += `<option value="${port.path}"${selected}>${this._escapeHtml(label)}</option>`;
                });
            } else {
                html += '<option value="">Refreshing available ports...</option>';
            }
            html += '</select>';
            html += '<p class="mt-2 text-xs text-grey">Choose the programming port for the blank controller, then flash will continue automatically.</p>';
            html += '</div>';
        } else if (!this.ws?.isConnected) {
            html += '<div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">';
            html += '<i data-lucide="triangle-alert" style="width:14px;height:14px"></i>';
            html += `<p class="text-xs text-amber-700">${this.programmingPortSelectionOpen ? 'Select a programming port to begin flashing.' : 'Connect to your controller in Ooznest Control before flashing firmware.'}</p>`;
            html += '</div>';
        }

        body.innerHTML = html;

        const canFlash = !this.busy && !!this.ws?.isConnected && !window.cordova;
        footer.innerHTML = `<button class="btn btn-secondary" data-modal-close ${this.busy ? 'disabled' : ''}>Close</button>`;
        if (this._reconnectSucceeded) {
            // Close is the only remaining action after a successful reconnect.
        } else if (!this.ws?.isConnected && window.electron) {
            if (this.programmingPortSelectionOpen && this.selectedProgrammingPort) {
                footer.innerHTML += `<button id="firmware-flasher-start" class="btn btn-primary whitespace-nowrap" ${this.busy ? 'disabled' : ''}>Flash Firmware</button>`;
            } else {
                footer.innerHTML += '<button id="firmware-flasher-choose-device" class="btn btn-primary whitespace-nowrap">Choose Device</button>';
            }
        } else if (!this.ws?.isConnected) {
            footer.innerHTML += '<button id="firmware-flasher-choose-device" class="btn btn-primary whitespace-nowrap">Choose Device</button>';
        } else if (this.browserReconnectPending && !window.electron) {
            footer.innerHTML += '<button id="firmware-flasher-reconnect" class="btn btn-primary whitespace-nowrap">Connect Controller</button>';
        } else {
            footer.innerHTML += `<button id="firmware-flasher-start" class="btn btn-primary whitespace-nowrap" ${canFlash ? '' : 'disabled'}>${this.busy ? 'Flashing...' : 'Flash Firmware'}</button>`;
        }
        footer.classList.remove('hidden');

        this._wireEvents();
        this._syncLogUI();
        if (window.lucide) window.lucide.createIcons();
    }

    _renderStepIndicator() {
        const steps = ['Firmware', 'Flash', 'Complete'];
        const currentStage = this._getStageIndex();
        let html = '<div class="wizard-stepper mb-6 px-1">';
        steps.forEach((label, i) => {
            const isActive = i === currentStage;
            const isDone = i < currentStage;
            html += `<div class="wizard-stepper__item ${isActive ? 'is-active' : ''} ${isDone ? 'is-complete' : ''}">`;
            if (isDone) {
                html += '<span class="wizard-stepper__circle"><i data-lucide="check" style="width:16px;height:16px"></i></span>';
            } else {
                html += `<span class="wizard-stepper__circle">${i + 1}</span>`;
            }
            html += `<span class="wizard-stepper__label">${label}</span>`;
            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    _getStageIndex() {
        if (this.browserReconnectPending || (!this.busy && this.progress >= 100)) return 2;
        if (this.busy || this.progress > 0) return 1;
        return 0;
    }

    _wireEvents() {
        document.querySelectorAll('.firmware-option').forEach((el) => {
            el.onclick = () => {
                if (this.busy || this.selectionLocked) return;
                this.selectedFirmware = el.dataset.value;
                this._render();
            };
        });

        const startButton = document.getElementById('firmware-flasher-start');
        if (startButton) {
            startButton.onclick = () => this.startFlash();
        }

        const reconnectButton = document.getElementById('firmware-flasher-reconnect');
        if (reconnectButton) {
            reconnectButton.onclick = () => this._reconnectBrowserController(true);
        }

        const chooseDeviceButton = document.getElementById('firmware-flasher-choose-device');
        if (chooseDeviceButton) {
            chooseDeviceButton.onclick = () => this.chooseProgrammingDevice();
        }

        const programmingPortSelect = document.getElementById('firmware-flasher-programming-port');
        if (programmingPortSelect) {
            programmingPortSelect.onchange = () => {
                this.selectedProgrammingPort = programmingPortSelect.value || null;
                this._render();
            };
        }
    }

    async startFlash() {
        if (this.busy || window.cordova) return;
        if (!this.ws?.isConnected && !(window.electron && this.programmingPortSelectionOpen && this.selectedProgrammingPort)) return;

        this.busy = true;
        this.selectionLocked = true;
        this.progress = 0;
        this.logLines = [];
        this.browserReconnectPending = false;
        this._browserReconnectAttempted = false;
        this._reconnectSucceeded = false;
        this.previousConnection = this.ws.getConnectionSnapshot ? this.ws.getConnectionSnapshot() : null;
        this._appendLog(`[SYSTEM] Selected ${this._getSelectedFirmwareLabel()}`);
        this._appendLog('[SYSTEM] Starting firmware update...');
        this._render();

        try {
            if (window.electron && !this.ws?.isConnected && this.programmingPortSelectionOpen && this.selectedProgrammingPort) {
                await this._flashWithElectron(this.selectedProgrammingPort);
            } else if (window.electron) {
                await this._flashWithElectron();
            } else {
                await this._flashWithWebSerial();
            }
        } catch (error) {
            this._appendLog(`[CRITICAL] ${error?.message || error}`);
            this.busy = false;
            this._render();
        }
    }

    async _flashWithElectron(programmingPort = null) {
        return this._flashWithElectronProgrammingPort(programmingPort);
    }

    async _flashWithElectronProgrammingPort(programmingPort) {
        if (!this.ws.backendWs || this.ws.backendWs.readyState !== WebSocket.OPEN) {
            await this.ws.connectToBackend();
        }

        const active = this.ws.getConnectionSnapshot?.();
        if (!programmingPort && (!active || active.type !== 'usb' || !active.port)) {
            throw new Error('Firmware flashing on desktop currently requires an active USB connection.');
        }

        const message = {
            type: 'firmwareFlash',
            firmwareKey: this.selectedFirmware,
            baud: (active && active.baud) || FIRMWARE_SERIAL_BAUDRATE
        };

        if (programmingPort) {
            this.programmingPortSelectionOpen = true;
            this.selectedProgrammingPort = programmingPort;
            this._appendLog(`[SYSTEM] Using selected programming port ${programmingPort}...`);
            message.programmingPort = programmingPort;
        } else {
            this._expectBootloaderDisconnect();
            this._appendLog(`[SYSTEM] Sending ${BOOTLOADER_COMMAND}...`);
            await this.ws.sendCommand(BOOTLOADER_COMMAND);
            await this._sleep(250);
            this._appendLog('[SYSTEM] Waiting for bootloader port and flashing automatically...');
            message.previousPort = active.port;
        }

        this.ws.backendWs.send(JSON.stringify(message));
    }

    async _flashWithWebSerial() {
        const { alreadyInBootloader } = await this._enterBootloaderFromBrowser();
        const baudrate = DEFAULT_FLASH_BAUDRATE;

        this._appendLog(alreadyInBootloader
            ? '[SYSTEM] Selected device is already in bootloader mode.'
            : '[SYSTEM] Controller is in bootloader mode. Select the flashing port if prompted.');

        const device = alreadyInBootloader
            ? this.ws.webSerial.port
            : await navigator.serial.requestPort({ filters: BOOTLOADER_FILTERS });

        const transport = new Transport(device);
        const esploader = new ESPLoader({
            transport,
            baudrate,
            terminal: this._createTerminal(),
            resetConstructors: {
                classicReset: (t, d) => new ClassicReset(t, d),
                hardReset: (t, u) => new HardReset(t, u),
                usbJTAGSerialReset: (t) => new UsbJtagSerialReset(t)
            }
        });

        try {
            await esploader.main(alreadyInBootloader ? 'no_reset' : 'no_reset');
            const images = await this._loadFirmwareImages(this.selectedFirmware);
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
                    this._setProgress(Math.round((written / total) * 100));
                }
            });

            this._appendLog('[RESET] Booting application...');
            await this._resetIntoApplication(esploader, transport, device);
            this._appendLog('[COMPLETE] Firmware flashed successfully.');
            this._notifyFlashComplete();
            this.browserReconnectPending = true;
            this._appendLog('[SYSTEM] Reconnecting to controller...');
            this._render();
            await this._reconnectBrowserController(false);
        } finally {
            try {
                await transport.disconnect();
            } catch (_) {
                // Best-effort transport cleanup.
            }
            this.busy = false;
            this._render();
        }
    }

    async chooseProgrammingDevice() {
        if (this.busy || window.cordova) return;

        if (!window.electron) {
            if (!navigator.serial?.requestPort) {
                this._appendLog('[CRITICAL] Web Serial is not available in this browser.');
                this._render();
                return;
            }

            try {
                const device = await navigator.serial.requestPort({ filters: BOOTLOADER_FILTERS });
                await this._flashWithSelectedProgrammingPortBrowser(device);
            } catch (error) {
                if (error?.name !== 'NotFoundError') {
                    this._appendLog(`[WARN] Port selection failed: ${error?.message || error}`);
                    this._render();
                }
            }
            return;
        }

        this.programmingPortSelectionOpen = true;
        this.selectedProgrammingPort = null;
        this.availableProgrammingPorts = [];
        this._render();
        await this.ws.refreshNodePorts();
    }

    async _flashWithSelectedProgrammingPortBrowser(device) {
        this.busy = true;
        this.selectionLocked = true;
        this.progress = 0;
        this.logLines = [];
        this.browserReconnectPending = false;
        this._browserReconnectAttempted = false;
        this._reconnectSucceeded = false;
        this._appendLog(`[SYSTEM] Selected ${this._getSelectedFirmwareLabel()}`);
        this._appendLog('[SYSTEM] Starting firmware update...');
        this._appendLog('[SYSTEM] Using selected programming port...');
        this._render();

        const transport = new Transport(device);
        const esploader = new ESPLoader({
            transport,
            baudrate: DEFAULT_FLASH_BAUDRATE,
            terminal: this._createTerminal(),
            resetConstructors: {
                classicReset: (t, d) => new ClassicReset(t, d),
                hardReset: (t, u) => new HardReset(t, u),
                usbJTAGSerialReset: (t) => new UsbJtagSerialReset(t)
            }
        });

        try {
            await esploader.main('no_reset');
            const images = await this._loadFirmwareImages(this.selectedFirmware);
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
                    this._setProgress(Math.round((written / total) * 100));
                }
            });

            this._appendLog('[RESET] Booting application...');
            await this._resetIntoApplication(esploader, transport, device);
            this._appendLog('[COMPLETE] Firmware flashed successfully.');
            this._notifyFlashComplete();
            this.browserReconnectPending = true;
            this._appendLog('[SYSTEM] Reconnecting to controller...');
            this._render();
            await this._reconnectBrowserController(false);
        } finally {
            try {
                await transport.disconnect();
            } catch (_) {
                // Best-effort transport cleanup.
            }
            this.busy = false;
            this._render();
        }
    }

    async _enterBootloaderFromBrowser() {
        let normalPort = this.ws.webSerial?.port || null;
        let writer = null;
        let alreadyInBootloader = false;

        if (!normalPort) {
            throw new Error('No browser serial port is connected.');
        }

        try {
            const info = normalPort.getInfo?.() || {};
            if (info.usbVendorId === BOOTLOADER_FILTERS[0].usbVendorId && info.usbProductId === BOOTLOADER_FILTERS[0].usbProductId) {
                alreadyInBootloader = true;
                return { alreadyInBootloader };
            }

            this._expectBootloaderDisconnect();
            this._appendLog(`[SYSTEM] Sending ${BOOTLOADER_COMMAND} to controller...`);
            await this.ws.sendCommand(BOOTLOADER_COMMAND);

            const onLine = (line) => {
                if (line.includes(BOOTLOADER_MESSAGE)) {
                    this._appendLog(`[SYSTEM] ${BOOTLOADER_MESSAGE}`);
                }
            };
            this.ws.on('line', onLine);
            await this._sleep(350);
            this.ws.off('line', onLine);

            await this.ws.disconnect();
            await this._sleep(500);
            return { alreadyInBootloader: false };
        } finally {
            if (writer) writer.releaseLock();
        }
    }

    async _loadFirmwareImages(firmwareKey) {
        const firmwareOption = FIRMWARE_OPTIONS.find((option) => option.key === firmwareKey);
        const firmwareFile = firmwareOption?.fileName || `${firmwareKey}.bin`;
        const loadFile = async (name) => {
            const response = await fetch(`./firmware/${name}`);
            if (!response.ok) {
                throw new Error(`Missing firmware asset: firmware/${name}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        };

        const [bootloader, partitions, firmware] = await Promise.all([
            loadFile('bootloader.bin'),
            loadFile('partitions.bin'),
            loadFile(firmwareFile)
        ]);

        return { bootloader, partitions, firmware };
    }

    async _resetIntoApplication(esploader, transport, device) {
        const info = device?.getInfo?.() || {};
        const isBootloaderPort = info.usbVendorId === BOOTLOADER_FILTERS[0].usbVendorId
            && info.usbProductId === BOOTLOADER_FILTERS[0].usbProductId;
        const isEsp32S3 = esploader?.chip?.CHIP_NAME === 'ESP32-S3';

        if (isBootloaderPort && isEsp32S3) {
            try {
                const RTC_CNTL_OPTION1_REG = 0x6000812C;
                const RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 0x1;
                const RTCCNTL_BASE_REG = 0x60008000;
                const RTC_CNTL_WDTCONFIG0_REG = RTCCNTL_BASE_REG + 0x0098;
                const RTC_CNTL_WDTCONFIG1_REG = RTCCNTL_BASE_REG + 0x009C;
                const RTC_CNTL_WDTWPROTECT_REG = RTCCNTL_BASE_REG + 0x00B0;
                const RTC_CNTL_WDT_WKEY = 0x50D83AA1;
                const RTC_WDT_ENABLE = (1 << 31) | (5 << 28) | (1 << 8) | 2;

                this._appendLog('[RESET] Clearing ESP32-S3 forced download boot flag...');
                await esploader.writeReg(RTC_CNTL_OPTION1_REG, 0, RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK);
                this._appendLog('[RESET] Resetting ESP32-S3 via RTC watchdog...');
                await esploader.writeReg(RTC_CNTL_WDTWPROTECT_REG, RTC_CNTL_WDT_WKEY);
                await esploader.writeReg(RTC_CNTL_WDTCONFIG1_REG, 2000);
                await esploader.writeReg(RTC_CNTL_WDTCONFIG0_REG, RTC_WDT_ENABLE);
                await esploader.writeReg(RTC_CNTL_WDTWPROTECT_REG, 0);
                await this._sleep(800);
            } catch (error) {
                this._appendLog(`[RESET] Register reset path failed: ${error?.message || error}`);
                this._appendLog('[RESET] Falling back to USB Serial/JTAG reset...');
                await new UsbJtagSerialReset(transport).reset();
            }
        } else if (isBootloaderPort) {
            this._appendLog('[RESET] Resetting via USB Serial/JTAG...');
            await new UsbJtagSerialReset(transport).reset();
        } else {
            this._appendLog('[RESET] Hard resetting device...');
            await esploader.after('hard_reset', false);
        }

        await this._sleep(RESET_DELAY_MS);
    }

    handleBackendMessage(msg) {
        this._lastBackendEvent = msg;

        if (msg.type === 'firmwareFlashLog' && msg.line) {
            this._appendLog(msg.line);
            return;
        }

        if (msg.type === 'firmwareFlashProgress') {
            this._setProgress(msg.percent || 0);
            return;
        }

        if (msg.type === 'firmwareFlashComplete') {
            this._setProgress(100);
            this._appendLog('[COMPLETE] Firmware flashed successfully.');
            this._notifyFlashComplete();
            this.busy = false;
            this.browserReconnectPending = !!msg.reconnect;
            this._render();
            if (msg.reconnect) {
                this._appendLog('[SYSTEM] Reconnecting to controller...');
                this._reconnectAfterElectronFlash(msg.reconnect).catch((error) => {
                    this._appendLog(`[WARN] Automatic reconnect failed: ${error?.message || error}`);
                    this._render();
                });
            }
            return;
        }

        if (msg.type === 'firmwareFlashError') {
            this._appendLog(`[CRITICAL] ${msg.message}`);
            this.busy = false;
            this.browserReconnectPending = false;
            this._render();
        }
    }

    _handleProgrammingPorts(ports) {
        const filtered = (ports || []).filter((port) => {
            const path = (port.path || '').toUpperCase();
            return path !== 'COM1' && path !== 'COM2';
        });
        this.availableProgrammingPorts = filtered;

        if (this.programmingPortSelectionOpen) {
            if (!this.selectedProgrammingPort && filtered.length === 1) {
                this.selectedProgrammingPort = filtered[0].path;
            }
            this._render();
        }
    }

    _notifyFlashComplete() {
        if (this._completionNotified) return;
        this._completionNotified = true;
        this.onFlashComplete?.(this.selectedFirmware);
    }

    async _reconnectAfterElectronFlash(reconnect) {
        const portInput = document.getElementById('port-node');
        if (portInput && reconnect.port) {
            portInput.value = reconnect.port;
        }

        await this._sleep(500);
        await this.ws.connect();
        this._appendLog('[SYSTEM] Controller Reconnected Successfully. You are now running the new firmware, you can close this dialog and continue.');
        this.browserReconnectPending = false;
        this._reconnectSucceeded = true;
        this._render();
    }

    async _reconnectBrowserController(forcePrompt = false) {
        if (this.busy && !this.browserReconnectPending) return;

        const baudRate = this.previousConnection?.baud || FIRMWARE_SERIAL_BAUDRATE;

        try {
            if (!forcePrompt && navigator.serial?.getPorts) {
                const ports = await navigator.serial.getPorts();
                const reconnectPort = ports.find((port) => {
                    const info = port.getInfo?.() || {};
                    return !(info.usbVendorId === BOOTLOADER_FILTERS[0].usbVendorId
                        && info.usbProductId === BOOTLOADER_FILTERS[0].usbProductId);
                });

                if (reconnectPort) {
                    this._appendLog('[SYSTEM] Found authorized controller port, reconnecting...');
                    await this.ws.webSerial.connectToPort(reconnectPort, baudRate);
                    this.browserReconnectPending = false;
                    this._appendLog('[SYSTEM] Controller Reconnected Successfully. You are now running the new firmware, you can close this dialog and continue.');
                    this._reconnectSucceeded = true;
                    this._render();
                    return;
                }
            }

            this._browserReconnectAttempted = true;
            if (!forcePrompt) {
                this._appendLog('[SYSTEM] Select your controller port to reconnect.');
                this._render();
                return;
            }

            this._appendLog('[SYSTEM] Opening port selector...');
            await this.ws.connect();
            this.browserReconnectPending = false;
            this._appendLog('[SYSTEM] Controller Reconnected Successfully. You are now running the new firmware, you can close this dialog and continue.');
            this._reconnectSucceeded = true;
            this._render();
        } catch (error) {
            this._appendLog(`[WARN] Reconnect failed: ${error?.message || error}`);
            this._render();
        }
    }

    _createTerminal() {
        return {
            clean: () => {},
            writeLine: (line) => this._appendLog(line),
            write: (line) => this._appendLog(line)
        };
    }

    _appendLog(line) {
        if (!line) return;
        const text = String(line).replace(/\r/g, '').trimEnd();
        const parts = text.split('\n').filter(Boolean);
        if (!parts.length) return;
        this.logLines.push(...parts);
        if (this.logLines.length > 250) {
            this.logLines = this.logLines.slice(-250);
        }
        this._syncLogUI();
    }

    _setProgress(percent) {
        this.progress = Math.max(0, Math.min(100, percent || 0));
        const bar = document.getElementById('firmware-flasher-progress-bar');
        const label = document.getElementById('firmware-flasher-progress-label');
        if (bar) bar.style.width = `${this.progress}%`;
        if (label) label.textContent = `${this.progress}%`;
    }

    _syncLogUI() {
        const el = document.getElementById('firmware-flasher-log');
        if (!el) return;
        el.innerHTML = this.logLines.length
            ? this.logLines.map((line) => `<div class="${this._getLogLineClass(line)}">${this._escapeHtml(line)}</div>`).join('')
            : '<div class="text-grey">Ready to flash.</div>';
        el.scrollTop = el.scrollHeight;
    }

    _getLogLineClass(line) {
        const text = String(line || '');
        if (text.includes('Controller Reconnected Successfully.')) {
            return 'text-teal-700 font-bold';
        }
        if (text.startsWith('[CRITICAL]')) {
            return 'text-red-600 font-bold';
        }
        if (text.startsWith('[WARN]')) {
            return 'text-amber-700';
        }
        if (text.startsWith('[COMPLETE]')) {
            return 'text-teal-700 font-bold';
        }
        if (text.startsWith('[RESET]')) {
            return 'text-grey-dark';
        }
        if (text.startsWith('[SYSTEM]')) {
            return 'text-grey-dark';
        }
        return 'text-grey-dark';
    }

    _getSelectedFirmwareLabel() {
        return FIRMWARE_OPTIONS.find((option) => option.key === this.selectedFirmware)?.label || this.selectedFirmware;
    }

    _expectBootloaderDisconnect(timeoutMs = 8000) {
        this._expectedDisconnectUntil = Date.now() + timeoutMs;
    }

    shouldSuppressConnectionError(err) {
        const active = this._expectedDisconnectUntil && Date.now() <= this._expectedDisconnectUntil;
        if (!active) return false;

        const message = String(err?.message || '').toLowerCase();
        const isExpectedBootloaderHandoffError = message.includes('connection lost:')
            || message.includes('device has been lost')
            || message.includes('port is closed');

        if (!isExpectedBootloaderHandoffError) return false;

        this._expectedDisconnectUntil = 0;
        this._appendLog('[SYSTEM] Controller reset detected, continuing firmware handoff...');
        return true;
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
