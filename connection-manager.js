import { GrblFlowControl } from './grbl-flow-control.js';
import { registerModal } from './modal.js';

export class ConnectionManager {
    constructor(webSerial) {
        this.webSerial = webSerial;
        this.flowControl = new GrblFlowControl(this);
        this.type = 'webserial'; // 'webserial', 'usb', 'telnet'
        this.backendWs = null;
        this.isElectron = window.electron !== undefined;
        // isCordova is checked dynamically since cordova.js loads async
        this.hasBackend = this.isElectron;
        this.httpBaseUrl = null;
        this._scanning = false;
        this._cordovaTelnetSocketId = null;
        this._isConnecting = false;
        // Direct connection mode — skip the connect modal entirely
        this._isDirectMode = !this.hasBackend && !this.isCordova;

        this.listeners = {
            connect: [],
            disconnect: [],
            line: [],
            sent: [],
            error: [],
            firmware: [],
            ports: []
        };
        this._backendBuffer = '';

        // UI element references
        this.modal = document.getElementById('connection-modal');
        this.modalController = registerModal(this.modal, { closeOnBackdrop: true, closeOnEscape: true });
        this.btnConnect = document.getElementById('btn-connect');

        // Expose globals for UI callbacks
        window.toggleConnectionModal = () => this.toggleModal();
        window.setConnectionType = (type) => this.setConnectionType(type);
        window.handleConnectClick = () => this.connect();
        window.refreshNodePorts = () => this.refreshNodePorts();
        window.scanTelnetNetwork = () => this.openTelnetScanner();
        window.openTelnetScanner = () => this.openTelnetScanner();
        window.closeTelnetScanner = () => this.closeTelnetScanner();
        window.startTelnetScanNetwork = () => this.startTelnetScanNetwork();
        window.updateTelnetScanStartState = () => this.updateTelnetScanStartState();

        // If we have a backend, initiate sync connection immediately
        if (this.hasBackend) {
            this.connectToBackend().catch(err => {
                console.log("Remote Mirror: Backend not available yet, will retry on interaction.");
            });
        }

        this.init();
    }

    get isConnected() {
        return this._isConnected;
    }

    set isConnected(val) {
        this._isConnected = val;
    }

    get isConnecting() {
        return this._isConnecting;
    }

    get isBrowserRuntime() {
        return !this.isElectron && !this.isCordova;
    }

    init() {
        const saved = this.loadSettings();
        if (saved) {
            if (saved.webserialBaud && document.getElementById('baud-webserial')) document.getElementById('baud-webserial').value = saved.webserialBaud;
            if (saved.usbBaud && document.getElementById('baud-node')) document.getElementById('baud-node').value = saved.usbBaud;
            if (saved.telnetIp && document.getElementById('ip-telnet')) document.getElementById('ip-telnet').value = saved.telnetIp;
            if (saved.telnetPort && document.getElementById('port-telnet')) document.getElementById('port-telnet').value = saved.telnetPort;
            if (saved.websocketUrl && document.getElementById('url-websocket')) {
                document.getElementById('url-websocket').value = saved.websocketUrl;
            }
        }
        const savedConnectionType = this._getSavedConnectionType(saved);

        // Intercept connect button click
        if (this.btnConnect) {
            this.btnConnect.onclick = () => {
                if (this.isConnected || this.isConnecting) {
                    this.disconnect();
                } else if (this._isDirectMode) {
                    this.connect();
                } else {
                    this.toggleModal();
                }
            };
        }

        // Initialize WebSerial listeners
        this.webSerial.on('connect', () => this.handleConnect());
        this.webSerial.on('disconnect', () => this.handleDisconnect());
        this.webSerial.on('line', (line) => this.emit('line', line));
        this.webSerial.on('error', (err) => this.emit('error', err));
        this.webSerial.on('sent', (line) => this.emit('sent', line));

        // Always listen for deviceready - cordova.js loads asynchronously
        // so window.cordova is not defined at constructor time.
        document.addEventListener("deviceready", () => {
            console.log("Cordova deviceready fired!");
            this.isCordova = true;
            this.hasBackend = true;
            this._isDirectMode = false;
            this.initCordova();

            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            const wsTab = document.getElementById('tab-websocket');
            const wsSerialTab = document.getElementById('tab-webserial');
            if (usbTab) usbTab.classList.remove('hidden');
            if (telnetTab) telnetTab.classList.remove('hidden');
            if (wsTab) wsTab.classList.add('hidden');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');

            this.setConnectionType(savedConnectionType || 'telnet');

            // Auto-discover grblHAL Telnet devices on local network
            setTimeout(() => {
                this._discoverTelnetDevices().then(devices => {
                    if (devices.length === 1) {
                        console.log("Auto-discovered 1 Telnet device:", devices[0]);
                        this._autoConnectTelnet(devices[0]);
                    } else if (devices.length > 1) {
                        console.log("Auto-discovered multiple Telnet devices:", devices);
                        this._showDiscoveredDevices(devices);
                    } else {
                        console.log("No Telnet devices discovered on network");
                    }
                });
            }, 2000);
        }, false);

        // UI initialization based on hosting environment
        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
            this.setConnectionType(savedConnectionType || 'usb');
        }

        if (this.isElectron || this.isCordova) {
            const wsSerialTab = document.getElementById('tab-webserial');
            const wsTab = document.getElementById('tab-websocket');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');
            if (wsTab) wsTab.classList.add('hidden');
        }

        if (this.isBrowserRuntime) {
            // Browser runtime uses native WebSerial unless SD mode exposes controller WebSocket.
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');

            this.setConnectionType('webserial');

            // Probe for SD card mode: if grblHAL's WebSocket responds on port 81,
            // we're being served from the controller's own filesystem
            this._probeSDMode();
        }
    }

    saveSettings() {
        if (typeof localStorage === 'undefined') return;
        try {
            const settings = {
                connectionType: this.type,
                webserialBaud: document.getElementById('baud-webserial')?.value,
                usbPort: document.getElementById('port-node')?.value,
                usbBaud: document.getElementById('baud-node')?.value,
                telnetIp: document.getElementById('ip-telnet')?.value,
                telnetPort: document.getElementById('port-telnet')?.value,
                websocketUrl: document.getElementById('url-websocket')?.value
            };
            localStorage.setItem('cnc_connection_settings', JSON.stringify(settings));
        } catch (e) {
            console.error("Error saving connection settings:", e);
        }
    }

    loadSettings() {
        if (typeof localStorage === 'undefined') return null;
        try {
            const stored = localStorage.getItem('cnc_connection_settings');
            if (stored) return JSON.parse(stored);
        } catch (e) {
            console.error("Error loading connection settings:", e);
        }
        return null;
    }

    _getSavedConnectionType(saved = null) {
        const settings = saved || this.loadSettings();
        const type = settings?.connectionType;
        if (!type) return null;

        if (this.isElectron || this.isCordova) {
            return ['usb', 'telnet'].includes(type) ? type : null;
        }

        if (this.isBrowserRuntime) {
            return ['webserial', 'websocket'].includes(type) ? type : null;
        }

        return null;
    }

    toggleModal() {
        if (!this.modalController) return;
        // In direct mode only allow closing, never opening the modal
        if (this._isDirectMode && !this.modalController.isOpen()) return;
        this.modalController.toggle();

        if (this.modalController.isOpen()) {
            this.setConnectionType(this.type);
        }

        // If showing USB tab and in Electron, refresh ports
        if (this.modalController.isOpen() && this.type === 'usb' && this.isElectron) {
            this.refreshNodePorts();
        }

        // Auto-hide connection tabs that don't apply to current platform
        if (this.isBrowserRuntime) {
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');
            if (this.type !== 'websocket') {
                this.setConnectionType('webserial');
            }
        } else if (this.isElectron || this.isCordova) {
            const wsSerialTab = document.getElementById('tab-webserial');
            const wsTab = document.getElementById('tab-websocket');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');
            if (wsTab) wsTab.classList.add('hidden');
        }

        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
        }
    }

    setConnectionType(type) {
        this.type = type;
        this.updateStreamingDescription();

        // Update Tabs
        ['webserial', 'usb', 'telnet', 'websocket'].forEach(t => {
            const tab = document.getElementById(`tab-${t}`);
            const config = document.getElementById(`config-${t}`);
            if (!tab || !config) return;

            if (t === type) {
                tab.classList.add('active');
                config.classList.remove('hidden');

                if (type === 'usb' && this.isCordova) {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.add('hidden');
                } else if (type === 'usb') {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.remove('hidden');
                }
            } else {
                tab.classList.remove('active');
                config.classList.add('hidden');
            }
        });

        if (type === 'usb' && this.isElectron) {
            if (!this.backendWs) {
                this.connectToBackend().then(() => this.refreshNodePorts()).catch(() => {});
            } else {
                this.refreshNodePorts();
            }
        }

        this.saveSettings();
    }

    updateStreamingDescription() {
        const description = document.getElementById('run-job-streaming-description');
        if (!description) return;

        description.textContent = this.type === 'webserial'
            ? 'Stream lines directly from your browser'
            : 'Stream lines directly from the application';
    }

    async _probeSDMode() {
        const url = `ws://${window.location.hostname}:81/ws`;
        let ws;
        try {
            await new Promise((resolve, reject) => {
                ws = new WebSocket(url);
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('timeout'));
                }, 1500);
                ws.onopen = () => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                };
                ws.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('connection failed'));
                };
            });
            // Probe succeeded — we're in SD card mode
            this.setConnectionType('websocket');
            const wsUrlInput = document.getElementById('url-websocket');
            if (wsUrlInput) wsUrlInput.value = url;
            this.httpBaseUrl = window.location.origin;
            setTimeout(() => this.connect(), 300);
        } catch {
            // Probe failed — regular web mode, stay on webserial
        }
    }

    connectToBackend() {
        if (this._connecting) return this._connecting;
        this._connecting = new Promise((resolve, reject) => {
            // If hostname is empty (e.g., file:// or some edge cases), default to localhost
            const host = window.location.hostname || 'localhost';
            const port = 8081;
            const wsUrl = `ws://${host}:${port}`;

            console.log("Remote Mirror: Syncing with backend at", wsUrl);

            this.backendWs = new WebSocket(wsUrl);

            this.backendWs.onopen = () => {
                console.log("Remote Mirror: Success. Session Sync active.");
                this._connecting = null;
                resolve();
            };

            this.backendWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                this.handleBackendMessage(msg);
            };

            this.backendWs.onerror = (err) => {
                console.error("Backend WS Error:", err);
                reject(err);
            };

            this.backendWs.onclose = () => {
                console.log("Backend WS Closed");
                this.backendWs = null;
                this._connecting = null;
                if (this.type !== 'webserial' && this.isConnected) {
                    this.handleDisconnect();
                }
            };
        });
        return this._connecting;
    }

    initCordova() {
        // Check for TCP Socket plugin (cordova-plugin-socket-tcp)
        try {
            var SocketMod = cordova.require('cordova-plugin-socket-tcp.Socket');
            this.CordovaSocket = SocketMod;
            console.log("Cordova TCP Socket Plugin Ready");
        } catch (e) {
            if (window.Socket) {
                this.CordovaSocket = window.Socket;
                console.log("Cordova TCP Socket Plugin Ready (global)");
            } else {
                console.log("Cordova TCP Socket plugin not available — Telnet will be disabled");
            }
        }

        if (!window.serial) {
            console.warn("Cordova Serial plugin not available — USB disabled");
            return;
        }

        console.log("Cordova Serial Plugin Ready");

        // Cordova Serial registration
        serial.registerReadCallback(
            (data) => {
                const view = new Uint8Array(data);
                if (this.rawModeCallback) {
                    this.rawModeCallback(view);
                } else {
                    const decoded = new TextDecoder().decode(view);
                    this._backendBuffer = (this._backendBuffer || '') + decoded;
                    const lines = this._backendBuffer.split('\n');
                    this._backendBuffer = lines.pop(); // Keep partial line
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) {
                            this.flowControl.processLine(trimmed);
                            this.emit('line', trimmed);
                        }
                    });
                }
            },
            (err) => {
                console.error("Cordova Serial Read Error:", err);
                const errMsg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                this.emit('error', new Error("Serial Read Error: " + errMsg));
            }
        );
    }

    handleBackendMessage(msg) {
        switch (msg.type) {
            case 'ports':
                this.emit('ports', msg.data || []);
                const select = document.getElementById('port-node');
                if (select) {
                    const ports = (msg.data || []).filter(p => {
                        const path = (p.path || '').toUpperCase();
                        return path !== 'COM1' && path !== 'COM2';
                    });
                    select.innerHTML = ports.map(p => `<option value="${p.path}">${p.friendlyName || p.path}</option>`).join('');
                    const saved = this.loadSettings();
                    if (saved && saved.usbPort && ports.some(p => p.path === saved.usbPort)) {
                        select.value = saved.usbPort;
                    }
                }
                break;
            case 'connected':
                this.flowControl.reset();
                this.handleConnect();
                break;
            case 'disconnected':
                this.flowControl.reset();
                this.handleDisconnect();
                break;
            case 'data':
                let bytes;
                if (msg.encoding === 'base64') {
                    const binaryString = atob(msg.data);
                    bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                } else {
                    bytes = new TextEncoder().encode(msg.data);
                }

                if (this.rawModeCallback) {
                    // console.log("Raw Mode Data Received:", bytes.length, "bytes");
                    this.rawModeCallback(bytes);
                } else {
                    const decoded = new TextDecoder().decode(bytes);
                    this._backendBuffer = (this._backendBuffer || '') + decoded;
                    const lines = this._backendBuffer.split('\n');
                    this._backendBuffer = lines.pop();
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) {
                            // Update flow control
                            this.flowControl.processLine(trimmed);
                            this.emit('line', trimmed);
                        }
                    });
                }
                break;
            case 'syncStatus':
                console.log("Syncing status from backend:", msg.status);
                // We'll use this to populate UI for new clients
                if (msg.status.gcode.content) {
                    // Avoid recursive loadGCode calls
                    if (window.loadGCode) window.loadGCode(msg.status.gcode.content, msg.status.gcode.filename, true);
                }

                if (msg.status.comms.connected) {
                    if (msg.status.comms.type) {
                        this.type = msg.status.comms.type;
                        window.setConnectionType(this.type);
                    }
                    if (!this.isConnected) {
                        this.handleConnect();
                    }
                } else {
                    this._syncHttpBaseUrl();
                }
                break;
            case 'gcodeLoaded':
                console.log("Remote G-Code Loaded:", msg.filename);
                if (window.loadGCode) window.loadGCode(msg.content, msg.filename, true);
                break;
            case 'statusUpdate':
                // Mirror status updates to UI modules
                if (msg.path.startsWith('machine.')) {
                    if (window.droHandler) {
                        const field = msg.path.split('.')[1];
                        if (field === 'status') {
                            if (window.droHandler.updateStatus) window.droHandler.updateStatus(msg.value);
                        } else if (field === 'wpos' || field === 'mpos') {
                            if (window.droHandler.updateDRO) {
                                // Synthetic update for mirrored clients
                                window.droHandler.updateDRO(msg.value, field === 'mpos');
                            }
                        }
                    }
                }
                if (msg.path.startsWith('job.')) {
                    if (window.jobController) {
                        if (msg.path === 'job.active') {
                            if (msg.value) window.jobController.startJobUI();
                            else window.jobController.resetJobUI();
                        } else if (msg.path === 'job.pct') {
                            window.jobController.updateJobProgressUI(msg.value, `Remote Job Progress`);
                        }
                    }
                }
                break;
            case 'scanTelnetProgress':
                this._setTelnetScanProgress(msg.percent, msg.message || `Scanning network... ${msg.percent}%`);
                break;
            case 'scanTelnetFound':
                this._appendDiscoveredDevice(msg.ip);
                break;
            case 'scanTelnetResult':
                const portInput2 = document.getElementById('port-telnet');
                const port2 = parseInt(portInput2?.value) || 23;
                this._handleScanResult(msg.devices || [], port2);
                break;
            case 'error':
                this._setConnectingState(false);
                this.emit('error', new Error(msg.message));
                break;
            case 'firmwareFlashLog':
            case 'firmwareFlashProgress':
            case 'firmwareFlashComplete':
            case 'firmwareFlashError':
                this.emit('firmware', msg);
                break;
        }
    }

    async refreshNodePorts() {
        if (!this.backendWs) await this.connectToBackend();
        if (this.backendWs && this.backendWs.readyState === WebSocket.OPEN) {
            this.backendWs.send(JSON.stringify({ type: 'listPorts' }));
        }
    }

    _showConnectingStatus(msg) {
        const dot = document.getElementById('connection-dot');
        const text = document.getElementById('connection-text');
        if (dot) {
            dot.classList.remove('bg-green-500', 'bg-red-500');
            dot.classList.add('bg-yellow-400');
        }
        if (text) text.textContent = msg || 'Connecting...';
    }

    _setConnectingState(isConnecting, message = 'Connecting...') {
        this._isConnecting = isConnecting;

        if (isConnecting) {
            this._showConnectingStatus(message);
        }

        const modalBtn = document.getElementById('btn-modal-connect');
        if (modalBtn) {
            modalBtn.textContent = isConnecting ? 'Connecting...' : 'Connect';
            modalBtn.disabled = isConnecting;
            modalBtn.classList.toggle('opacity-50', isConnecting);
            modalBtn.classList.toggle('pointer-events-none', isConnecting);
        }

        if (!this.btnConnect) return;

        if (isConnecting) {
            this.btnConnect.innerHTML = '<i data-lucide="x-circle"></i> Disconnect';
            if (window.lucide) {
                lucide.createIcons({ root: this.btnConnect });
            }
            this.btnConnect.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-yellow-500 !text-secondary-dark hover:!bg-yellow-400";
        } else if (!this.isConnected) {
            this.btnConnect.textContent = 'Connect';
            this.btnConnect.className = "btn btn-primary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0";
        }
    }

    _clearConnectingStatus() {
        // Restored by handleConnect/handleDisconnect via uiManager
    }

    async connect() {
        this.saveSettings();
        
        if (this.type === 'webserial') {
            const baud = parseInt(document.getElementById('baud-webserial').value);
            await this.webSerial.connect(baud);
        } else if (this.type === 'usb') {
            if (!this.backendWs && !this.isCordova) await this.connectToBackend();
            const port = document.getElementById('port-node').value;
            const baud = parseInt(document.getElementById('baud-node').value);
            this._setConnectingState(true, `Opening ${port || 'USB port'}...`);

            if (this.isCordova) {
                // Supported devices: STM32 (1155:22336) and ESP32-S3 (12346:16385)
                const supportedDevices = [
                    { vid: 1155, pid: 22336, name: 'STM32' },
                    { vid: 12346, pid: 16385, name: 'ESP32-S3' }
                ];

                const tryConnect = (index) => {
                    if (index >= supportedDevices.length) {
                        this._setConnectingState(false);
                        this.emit('error', new Error("No supported USB device found or permission denied."));
                        return;
                    }

                    const device = supportedDevices[index];
                    console.log(`Trying Cordova USB Permission for: ${device.name} (VID: ${device.vid}, PID: ${device.pid})`);

                    serial.requestPermission(
                        { vid: device.vid, pid: device.pid },
                        () => {
                            serial.open(
                                { baudRate: baud, sleepOnPause: false },
                                () => {
                                    console.log(`Cordova Serial Open Success [${device.name}]`);
                                    this.flowControl.reset();
                                    this.handleConnect();
                                },
                                (err) => {
                                    console.error(`Cordova Serial Open Error [${device.name}]:`, err);
                                    // If "No device found", try the next one in the list
                                    if (err.toString().toLowerCase().includes("no device") || err.toString().toLowerCase().includes("not found")) {
                                        tryConnect(index + 1);
                                    } else {
                                        this._setConnectingState(false);
                                        const errMsg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                                        this.emit('error', new Error("Can't open port: " + errMsg));
                                    }
                                }
                            );
                        },
                        (err) => {
                            console.warn(`Cordova USB Permission Denied/Next [${device.name}]:`, err);
                            // Device might not be plugged in, or it might be the wrong one. Try next.
                            tryConnect(index + 1);
                        });
                };

                tryConnect(0);
            } else {
                this.backendWs.send(JSON.stringify({
                    type: 'connect',
                    connectionType: 'usb',
                    port: port,
                    baud: baud
                }));
            }
        } else if (this.type === 'telnet') {
            const ip = document.getElementById('ip-telnet').value;
            const port = parseInt(document.getElementById('port-telnet').value) || 23;
            this._setConnectingState(true, `Connecting to ${ip}:${port}...`);
            if (this.isCordova) {
                await this._connectCordovaTelnet(ip, port);
            } else {
                if (!this.backendWs) await this.connectToBackend();
                this.backendWs.send(JSON.stringify({
                    type: 'connect',
                    connectionType: 'telnet',
                    ip: ip,
                    port: port
                }));
            }
        } else if (this.type === 'websocket') {
            if (this.isCordova) {
                this.emit('error', new Error('WebSocket is not supported on Cordova (HTTPS restricts ws://). Please use Telnet instead.'));
                this.modalController?.hide();
                return;
            }
            const url = document.getElementById('url-websocket').value || `ws://${window.location.hostname}:81/ws`;
            this._setConnectingState(true, `Connecting to ${url}...`);

            let connectionTimedOut = false;
            const connectTimeout = setTimeout(() => {
                if (this.directWs && this.directWs.readyState !== WebSocket.OPEN) {
                    connectionTimedOut = true;
                    this.directWs.close();
                    this.directWs = null;
                    const dot = document.getElementById('connection-dot');
                    const text = document.getElementById('connection-text');
                    if (dot) {
                        dot.classList.remove('bg-yellow-400');
                        dot.classList.add('bg-red-500');
                    }
                    if (text) text.textContent = 'Connection timed out';
                    this._setConnectingState(false);
                    this.emit('error', new Error(`WebSocket connection to ${url} timed out after 10s. Check that the IP is correct and the controller is reachable.`));
                }
            }, 10000);

            try {
                this.directWs = new WebSocket(url);
            } catch (e) {
                clearTimeout(connectTimeout);
                const dot = document.getElementById('connection-dot');
                const text = document.getElementById('connection-text');
                if (dot) {
                    dot.classList.remove('bg-yellow-400');
                    dot.classList.add('bg-red-500');
                }
                if (text) text.textContent = 'Connection Error';
                const isHttps = window.location.protocol === 'https:' || window.location.protocol === 'file:';
                if (isHttps && url.startsWith('ws://')) {
                    this.emit('error', new Error(`Cannot use ws:// from HTTPS page. Try Telnet instead: connect to the same IP on port 23.`));
                } else {
                    const wsErr = (typeof e === 'string') ? e : (e && e.message) ? e.message : JSON.stringify(e);
                    this.emit('error', new Error(`Invalid WebSocket URL: ${wsErr}`));
                }
                this._setConnectingState(false);
                this.modalController?.hide();
                return;
            }

            this.directWs.onopen = () => {
                clearTimeout(connectTimeout);
                console.log("Direct WebSocket Connected to grblHAL");
                try {
                    const wsUrl = new URL(url);
                    this.httpBaseUrl = `http://${wsUrl.hostname}`;
                    console.log("Derived HTTP Base URL:", this.httpBaseUrl);
                } catch (e) {
                    console.error("Failed to derive HTTP URL from WebSocket URL:", url);
                }
                this.flowControl.reset();
                this.handleConnect();
            };

            this.directWs.onmessage = (event) => {
                if (event.data instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const view = new Uint8Array(reader.result);
                        if (this.rawModeCallback) {
                            this.rawModeCallback(view);
                        } else {
                            const decoded = new TextDecoder().decode(view);
                            this._handleDirectWsData(decoded);
                        }
                    };
                    reader.readAsArrayBuffer(event.data);
                } else if (typeof event.data === 'string') {
                    this._handleDirectWsData(event.data);
                }
            };

            this.directWs.onerror = (err) => {
                if (connectionTimedOut) return;
                clearTimeout(connectTimeout);
                console.error("Direct WebSocket Error:", err);
                const dot = document.getElementById('connection-dot');
                const text = document.getElementById('connection-text');
                if (dot) {
                    dot.classList.remove('bg-yellow-400');
                    dot.classList.add('bg-red-500');
                }
                if (text) text.textContent = 'WebSocket Error';
                this._setConnectingState(false);
                this.emit('error', new Error("WebSocket connection failed. Make sure the controller is powered on and reachable."));
            };

            this.directWs.onclose = (event) => {
                clearTimeout(connectTimeout);
                console.log("Direct WebSocket Closed (code: " + event.code + ")");
                if (this.isConnected) this.handleDisconnect();
            };
        }
        this.modalController?.hide();
    }

    _handleDirectWsData(decoded) {
        this._backendBuffer = (this._backendBuffer || '') + decoded;
        const lines = this._backendBuffer.split('\n');
        this._backendBuffer = lines.pop(); // Keep partial line
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
                this.flowControl.processLine(trimmed);
                this.emit('line', trimmed);
            }
        });
    }

    async _connectCordovaTelnet(host, port) {
        if (!this.CordovaSocket) {
            this.emit('error', new Error("TCP Socket plugin not available. Cannot connect via Telnet."));
            return;
        }

        this._showConnectingStatus(`Connecting to ${host}:${port} (Telnet)...`);

        return new Promise((resolve, reject) => {
            const socket = new this.CordovaSocket();

            socket.onData = (data) => {
                const decoded = new TextDecoder().decode(data);
                console.log("Telnet RX:", JSON.stringify(decoded));
                this._backendBuffer = (this._backendBuffer || '') + decoded;
                const lines = this._backendBuffer.split('\n');
                this._backendBuffer = lines.pop();
                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        this.flowControl.processLine(trimmed);
                        this.emit('line', trimmed);
                    }
                });
            };

            socket.onError = (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Cordova Telnet Error payload:", JSON.stringify(err));
                console.error("Cordova Telnet Error msg:", msg);
                if (!this.isConnected) {
                    reject(new Error(msg));
                } else {
                    this.emit('error', new Error("Telnet error: " + msg));
                }
            };

            socket.onClose = (hasError) => {
                console.log("Cordova Telnet Closed (hasError:", hasError, ")");
                this._cordovaTelnetSocket = null;
                if (this.isConnected) this.handleDisconnect();
            };

            socket.open(host, port, () => {
                this._cordovaTelnetSocket = socket;
                console.log("Cordova Telnet Connected, waiting 2s for board to stabilize...");
                this.flowControl.reset();
                setTimeout(() => {
                    console.log("Cordova Telnet delay complete, activating connection");
                    this.handleConnect();
                    resolve();
                }, 2000);
            }, (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Cordova Telnet Open failed:", msg);
                this.emit('error', new Error("Telnet connection failed: " + msg));
                reject(new Error(msg));
            });
        });
    }

    disconnect() {
        this._setConnectingState(false);

        if (this.type === 'webserial') {
            this.webSerial.disconnect();
        } else if (this.type === 'websocket' && this.directWs) {
            this.directWs.close();
            this.directWs = null;
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            this._cordovaTelnetSocket.close();
            this._cordovaTelnetSocket = null;
            this.handleDisconnect();
        } else if (this.backendWs) {
            this.backendWs.send(JSON.stringify({ type: 'disconnect' }));
        }
    }

    _keepAwake(enable) {
        try {
            if (enable && window.plugins && window.plugins.insomnia) {
                window.plugins.insomnia.keepAwake();
            } else if (window.plugins && window.plugins.insomnia) {
                window.plugins.insomnia.allowSleepAgain();
            }
        } catch (e) {}
    }

    _syncHttpBaseUrl() {
        if (this.isConnected && this.type === 'telnet' && this.hasBackend) {
            this.httpBaseUrl = window.location.origin;
            return;
        }

        if (this.type !== 'websocket') {
            this.httpBaseUrl = null;
        }
    }

    clearPendingState() {
        this._backendBuffer = '';
        this.flowControl.reset();
        if (this.webSerial?.clearPendingState) {
            this.webSerial.clearPendingState();
        }
    }

    handleConnect() {
        this._setConnectingState(false);
        this.clearPendingState();
        this.isConnected = true;
        this._syncHttpBaseUrl();
        this.emit('connect');
        this._keepAwake(true);
        const sidebar = document.getElementById('machine-sidebar');
        if (sidebar && !sidebar.classList.contains('open')) {
            sidebar.classList.add('open');
            const overlay = document.getElementById('machine-sidebar-overlay');
            if (overlay) overlay.classList.remove('hidden');
        }
    }

    handleDisconnect() {
        this._setConnectingState(false);
        this.clearPendingState();
        this.isConnected = false;
        this._syncHttpBaseUrl();
        this.emit('disconnect');
        this._keepAwake(false);
    }

    // --- Data Transmission ---

    async sendCommand(line) {
        if (typeof line === 'string' && line.trim().toUpperCase() === '$X') {
            this.clearPendingState();
        }

        if (this.type === 'webserial') {
            await this.webSerial.sendCommand(line);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.isCordova && window.serial) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.backendWs) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        }
    }

    async sendRealtime(char) {
        if (char === '\x18') {
            this.clearPendingState();
        }

        if (this.type === 'webserial') {
            await this.webSerial.sendRealtime(char);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(char);
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            const bytes = new TextEncoder().encode(char);
            console.log("Telnet TX realtime:", JSON.stringify(char));
            this._cordovaTelnetSocket.write(bytes, () => {
                console.log("Telnet TX realtime success");
            }, (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Telnet Realtime TX Error:", msg);
            });
        } else if (this.isCordova && window.serial) {
            if (this._cordovaWriting) return;
            this._cordovaWriting = true;

            const hexChar = char.charCodeAt(0).toString(16).padStart(2, '0');
            await new Promise((resolve) => {
                serial.writeHex(hexChar, resolve, (err) => {
                    console.error("Cordova Serial TX Error:", err);
                    resolve();
                });
            });
            this._cordovaWriting = false;
        } else if (this.backendWs) {
            const bytes = new TextEncoder().encode(char);
            const binary = String.fromCharCode.apply(null, bytes);
            const base64 = btoa(binary);
            this.backendWs.send(JSON.stringify({ type: 'write', data: base64, encoding: 'base64' }));
        }
    }

    async writeRaw(data) {
        if (this.type === 'webserial') {
            await this.webSerial.writeRaw(data);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(new Uint8Array(data));
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            const bytes = new Uint8Array(data);
            console.log("Telnet TX writeRaw:", bytes.length, "bytes");
            await new Promise((resolve) => {
                this._cordovaTelnetSocket.write(bytes, () => {
                    console.log("Telnet TX writeRaw success");
                    resolve();
                }, (err) => {
                    const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                    console.error("Telnet Raw TX Error:", msg);
                    resolve();
                });
            });
        } else if (this.isCordova && window.serial) {
            while (this._cordovaWriting) {
                await new Promise(r => setTimeout(r, 2));
            }
            this._cordovaWriting = true;

            const bytes = new Uint8Array(data);
            let hexCmd = "";
            for (let i = 0; i < bytes.length; i++) {
                hexCmd += bytes[i].toString(16).padStart(2, '0');
            }
            await new Promise((resolve) => {
                serial.writeHex(hexCmd, resolve, (err) => {
                    console.error("Cordova Serial TX Error:", err);
                    resolve();
                });
            });
            this._cordovaWriting = false;
        } else if (this.backendWs) {
            // Efficiently convert Uint8Array to Base64
            const bytes = new Uint8Array(data);
            // Using fromCodePoint or apply on fromCharCode is faster for small/medium chunks
            const binary = String.fromCharCode.apply(null, bytes);
            const base64 = btoa(binary);
            this.backendWs.send(JSON.stringify({ type: 'write', data: base64, encoding: 'base64' }));
        }
    }

    setRawHandler(callback) {
        this.rawModeCallback = callback;
        if (this.type === 'webserial') {
            this.webSerial.setRawHandler(callback);
        }
    }

    // --- Event Emitter ---
    on(event, callback) {
        if (this.listeners[event]) this.listeners[event].push(callback);
    }

    removeListener(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    off(event, callback) {
        this.removeListener(event, callback);
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    getConnectionSnapshot() {
        if (this.type === 'usb') {
            return {
                type: 'usb',
                port: document.getElementById('port-node')?.value || null,
                baud: parseInt(document.getElementById('baud-node')?.value) || 115200
            };
        }

        if (this.type === 'webserial') {
            return {
                type: 'webserial',
                baud: parseInt(document.getElementById('baud-webserial')?.value) || 115200
            };
        }

        if (this.type === 'telnet') {
            return {
                type: 'telnet',
                ip: document.getElementById('ip-telnet')?.value || null,
                port: parseInt(document.getElementById('port-telnet')?.value) || 23
            };
        }

        if (this.type === 'websocket') {
            return {
                type: 'websocket',
                url: document.getElementById('url-websocket')?.value || null
            };
        }

        return { type: this.type };
    }

    _isPrivateIPv4(ip) {
        return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
    }

    _deriveSubnetCandidates(networkInfo) {
        const seen = new Set();
        const candidates = [];

        for (const entry of networkInfo || []) {
            const address = typeof entry === 'string' ? entry : entry.address;
            const name = typeof entry === 'string' ? '' : (entry.name || '');
            const netmask = typeof entry === 'string' ? '' : (entry.netmask || '');
            if (!address || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue;
            if (netmask === '255.255.255.255') continue;

            const subnet = address.split('.').slice(0, 3).join('.');
            if (seen.has(subnet)) continue;
            seen.add(subnet);

            let score = 0;
            if (this._isPrivateIPv4(address)) score += 100;
            if (netmask === '255.255.255.0') score += 20;
            if (/tailscale|hyper-v|vethernet|virtualbox|vmware|docker|wsl/i.test(name)) score -= 100;
            if (/^169\.254\./.test(address)) score -= 100;
            if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score -= 80;

            candidates.push({
                subnet,
                address,
                name,
                label: name ? `${subnet}.x (${address} via ${name})` : `${subnet}.x (${address})`,
                score
            });
        }

        candidates.sort((a, b) => b.score - a.score || a.subnet.localeCompare(b.subnet));
        return candidates;
    }

    async _getPreferredScanSubnets() {
        if (this.isElectron && window.electron?.getNetworkInfo) {
            try {
                const info = await window.electron.getNetworkInfo();
                const candidates = this._deriveSubnetCandidates(info);
                if (candidates.length) return candidates;
            } catch (e) {
                console.error('Failed to enumerate network interfaces for scan:', e);
            }
        }

        try {
            const localIP = await this._getLocalIP();
            if (localIP && this._isPrivateIPv4(localIP)) {
                const subnet = localIP.split('.').slice(0, 3).join('.');
                return [{
                    subnet,
                    address: localIP,
                    name: this.isCordova ? 'Device Network' : 'Local Network',
                    label: `${subnet}.x (${localIP} inferred)`,
                    score: 50
                }];
            }
        } catch (e) {
            console.error('Failed to infer local IP for scan:', e);
        }

        if (window.location.hostname !== 'localhost'
            && window.location.hostname !== '127.0.0.1'
            && /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)
            && this._isPrivateIPv4(window.location.hostname)) {
            const subnet = window.location.hostname.split('.').slice(0, 3).join('.');
            return [{
                subnet,
                address: window.location.hostname,
                name: 'Current Host',
                label: `${subnet}.x (${window.location.hostname} current host)`,
                score: 40
            }];
        }

        return [
            { subnet: '192.168.0', label: '192.168.0.x', score: 0 },
            { subnet: '192.168.1', label: '192.168.1.x', score: 0 },
            { subnet: '192.168.4', label: '192.168.4.x', score: 0 },
            { subnet: '10.0.0', label: '10.0.0.x', score: 0 }
        ];
    }

    // --- Network Scanner ---
    async scanNetwork() {
        const resultsDiv = document.getElementById('scan-results');
        const statusDiv = document.getElementById('scan-status');
        const btn = document.getElementById('btn-scan-network');

        if (this._scanning) return;
        this._scanning = true;

        btn.disabled = true;
        btn.classList.add('opacity-50');
        resultsDiv.innerHTML = '';
        resultsDiv.classList.remove('hidden');
        statusDiv.classList.remove('hidden');

        // Common subnets to try
        let subnets = ['192.168.1', '192.168.0', '192.168.4', '10.0.0'];

        // Try to detect local subnet if in Electron or non-localhost web
        if (this.isElectron && window.electron.getNetworkInfo) {
            try {
                const ips = await window.electron.getNetworkInfo();
                ips.forEach(item => {
                    const ip = typeof item === 'string' ? item : item.address;
                    const parts = ip.split('.');
                    if (parts.length === 4) {
                        parts.pop();
                        const subnet = parts.join('.');
                        if (!subnets.includes(subnet)) subnets.unshift(subnet);
                    }
                });
            } catch (e) { console.error("Scanner subnet detection failed:", e); }
        } else if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)) {
            const parts = window.location.hostname.split('.');
            parts.pop();
            const subnet = parts.join('.');
            if (!subnets.includes(subnet)) subnets.unshift(subnet);
        }

        const found = [];
        const checkIP = async (ip) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 800);
                // We check for /sdfiles?action=list which is a core Plugin_WebUI endpoint
                const resp = await fetch(`http://${ip}/sdfiles?action=list`, { signal: controller.signal }).catch(() => null);
                clearTimeout(timeoutId);

                if (resp && resp.ok) {
                    try {
                        const data = await resp.json();
                        // grblHAL Plugin_WebUI returns specific JSON structure
                        if (data && data.status === 'ok' && data.files !== undefined) {
                            return { ip, name: 'grblHAL Controller' };
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        };

        // Parallel scan with limited concurrency
        const concurrency = 15;
        for (const subnet of subnets) {
            statusDiv.textContent = `Scanning ${subnet}.x...`;
            const tasks = [];
            for (let i = 1; i < 255; i++) {
                const ip = `${subnet}.${i}`;
                tasks.push((async () => {
                    const res = await checkIP(ip);
                    if (res) {
                        found.push(res);
                        this._addScanResult(res);
                    }
                })());

                if (tasks.length >= concurrency) {
                    await Promise.all(tasks);
                    tasks.length = 0;
                }
            }
            await Promise.all(tasks);
        }

        this._scanning = false;
        btn.disabled = false;
        btn.classList.remove('opacity-50');
        statusDiv.classList.add('hidden');

        if (found.length === 0) {
            resultsDiv.innerHTML = '<div class="text-[10px] text-grey text-center py-2">No controllers found.</div>';
        }
    }

    _addScanResult(res) {
        const resultsDiv = document.getElementById('scan-results');
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between p-1.5 hover:bg-white rounded cursor-pointer transition-colors border-b border-grey-light last:border-b-0 group';
        div.innerHTML = `
            <div class="flex flex-col">
                <span class="text-xs font-bold text-secondary-dark">${res.ip}</span>
                <span class="text-[9px] text-grey uppercase font-bold text-primary">${res.name}</span>
            </div>
            <i data-lucide="chevron-right" style="width:14px;height:14px"></i>
        `;
        div.onclick = () => {
            const urlInput = document.getElementById('url-websocket');
            if (urlInput) {
                urlInput.value = `ws://${res.ip}:81/ws`;
            }
            const telnetIpInput = document.getElementById('ip-telnet');
            if (telnetIpInput) {
                telnetIpInput.value = res.ip;
            }
            // Auto-hide results
            resultsDiv.classList.add('hidden');
        };
        resultsDiv.appendChild(div);
    }

    // --- Cordova Telnet auto-discovery ---

    async openTelnetScanner() {
        const btn = document.getElementById('btn-scan-telnet');
        if (btn) btn.disabled = true;
        this._setTelnetScanMode(true);
        this._resetTelnetScanUI('Select a network adapter to begin scanning.');
        await this._populateTelnetSubnetOptions();
        this.updateTelnetScanStartState();
        if (btn) btn.disabled = false;
    }

    async scanTelnetNetwork() {
        return this.openTelnetScanner();
    }

    updateTelnetScanStartState() {
        const startBtn = document.getElementById('btn-start-telnet-scan');
        const subnetSelect = document.getElementById('discover-subnet-select');
        if (!startBtn || !subnetSelect) return;
        const canStart = !!subnetSelect.value;
        startBtn.disabled = !canStart;
        startBtn.classList.toggle('opacity-50', !canStart);
        startBtn.classList.toggle('pointer-events-none', !canStart);
    }

    _setTelnetScanMode(enabled) {
        const ipWrap = document.getElementById('telnet-manual-ip-wrap');
        const portWrap = document.getElementById('telnet-manual-port-wrap');
        const panel = document.getElementById('discover-panel');
        const btn = document.getElementById('btn-scan-telnet');
        const connectBtn = document.getElementById('btn-modal-connect');

        if (ipWrap) ipWrap.classList.toggle('hidden', enabled);
        if (portWrap) portWrap.classList.toggle('hidden', enabled);
        if (panel) panel.classList.toggle('hidden', !enabled);
        if (connectBtn) connectBtn.classList.toggle('hidden', enabled);

        if (btn) {
            btn.innerHTML = enabled
                ? '<i data-lucide="keyboard" style="width:14px;height:14px"></i> MANUAL ENTRY'
                : '<i data-lucide="search" style="width:14px;height:14px"></i> SCAN NETWORK';
            btn.onclick = enabled
                ? () => this.closeTelnetScanner()
                : () => this.openTelnetScanner();
        }
    }

    closeTelnetScanner() {
        this._setTelnetScanMode(false);
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        if (btn) btn.disabled = false;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    async startTelnetScanNetwork() {
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        const portInput = document.getElementById('port-telnet');
        const port = parseInt(portInput?.value) || 23;
        const subnetSelect = document.getElementById('discover-subnet-select');
        const selectedSubnet = subnetSelect?.value || '';

        if (!selectedSubnet) {
            this._setTelnetScanStatus('Select a network adapter before starting the scan.');
            return;
        }

        if (btn) btn.disabled = true;
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.classList.add('opacity-50', 'pointer-events-none');
        }
        this._resetTelnetScanUI(`Starting scan on port ${port}...`);
        if (subnetSelect) subnetSelect.value = selectedSubnet;
        this._setTelnetScanProgress(0, `Scanning ${selectedSubnet}.x on port ${port}...`);

        if (this.isCordova && this.CordovaSocket) {
            const devices = await this._discoverTelnetDevices(port, selectedSubnet);
            this._handleScanResult(devices, port);
        } else if (this.isElectron) {
            if (!this.backendWs) await this.connectToBackend();
            this.backendWs.send(JSON.stringify({ type: 'scanTelnet', port, subnet: selectedSubnet }));
        } else {
            this._setTelnetScanStatus('Telnet scanning unavailable on this platform');
            this._setTelnetScanProgress(null);
            if (btn) btn.disabled = false;
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        }
    }

    _handleScanResult(devices, port) {
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        if (btn) btn.disabled = false;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
        this._setTelnetScanProgress(devices.length > 0 ? 100 : null);

        if (devices.length > 0) {
            this._setTelnetScanStatus(`Found ${devices.length} grblHAL devices on port ${port}`);
            this._showDiscoveredDevices(devices);
        } else {
            this._setTelnetScanStatus(`No grblHAL devices found on port ${port}`);
            this._showDiscoveredDevices([]);
        }
    }

    _getTelnetScanEls() {
        return {
            panel: document.getElementById('discover-panel'),
            status: document.getElementById('discover-status'),
            subnetWrap: document.getElementById('discover-subnet-wrap'),
            subnetSelect: document.getElementById('discover-subnet-select'),
            progressWrap: document.getElementById('discover-progress-wrap'),
            progressBar: document.getElementById('discover-progress-bar'),
            container: document.getElementById('discovered-devices'),
            list: document.getElementById('discovered-list')
        };
    }

    _resetTelnetScanUI(statusText = '') {
        const { panel, status, progressWrap, progressBar, container, list } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (status) status.textContent = statusText;
        if (progressWrap) progressWrap.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        if (container) container.classList.add('hidden');
        if (list) list.innerHTML = '';
    }

    async _populateTelnetSubnetOptions() {
        const { panel, subnetWrap, subnetSelect } = this._getTelnetScanEls();
        if (!subnetSelect) return null;

        const candidates = await this._getPreferredScanSubnets();
        subnetSelect.innerHTML = [
            '<option value="">Select Network Adapter</option>',
            ...candidates.map(candidate =>
            `<option value="${candidate.subnet}">${candidate.label}</option>`
            )
        ].join('');

        if (panel) panel.classList.remove('hidden');
        if (subnetWrap) subnetWrap.classList.remove('hidden');

        return candidates[0]?.subnet || null;
    }

    _setTelnetScanStatus(text) {
        const { panel, status } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (status) status.textContent = text;
    }

    _setTelnetScanProgress(percent, text = null) {
        const { panel, status, progressWrap, progressBar } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (text && status) status.textContent = text;
        if (percent === null || percent === undefined) {
            if (progressWrap) progressWrap.classList.add('hidden');
            if (progressBar) progressBar.style.width = '0%';
            return;
        }
        if (progressWrap) progressWrap.classList.remove('hidden');
        if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    async _getLocalIP() {
        return new Promise((resolve) => {
            try {
                const pc = new RTCPeerConnection({ iceServers: [] });
                pc.createDataChannel('');
                pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
                let resolved = false;
                pc.onicecandidate = (ice) => {
                    if (resolved) return;
                    if (!ice || !ice.candidate || !ice.candidate.candidate) {
                        if (!resolved) { pc.close(); resolve(null); resolved = true; }
                        return;
                    }
                    const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(ice.candidate.candidate);
                    if (m) {
                        const ip = m[1];
                        if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
                            resolved = true;
                            pc.close();
                            resolve(ip);
                        }
                    }
                };
                setTimeout(() => { if (!resolved) { pc.close(); resolve(null); resolved = true; } }, 2000);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async _discoverTelnetDevices(port, subnetOverride = null) {
        if (!this.isCordova || !this.CordovaSocket) return [];

        port = port || 23;
        this._setTelnetScanStatus(`Scanning network on port ${port}...`);
        this._setTelnetScanProgress(0);

        const devices = [];

        // Step 1: Try saved IP first (fast path, with longer timeout)
        const saved = this.loadSettings();
        if (saved && saved.telnetIp) {
            this._setTelnetScanStatus(`Checking ${saved.telnetIp}...`);
            const found = await this._checkTelnetPortSequential(saved.telnetIp, port, 2000);
            if (found) {
                devices.push(found);
                return devices;
            }
        }

        // Step 2: Detect local subnet via WebRTC
        let localIP = null;
        try {
            localIP = await this._getLocalIP();
        } catch (e) {}

        const subnets = [];
        if (subnetOverride) {
            subnets.push(subnetOverride);
        } else if (localIP) {
            const parts = localIP.split('.');
            subnets.push(parts.slice(0, 3).join('.'));
        } else {
            subnets.push('192.168.0', '192.168.1', '192.168.4', '10.0.0');
        }

        // Step 3: Sequential TCP scan (plugin tracks by port, so only one connection at a time)
        for (const subnet of subnets) {
            devices.push(...await this._tcpScanSubnetSequential(subnet, port, subnets.length, (ip) => {
                this._appendDiscoveredDevice(ip);
            }));
        }

        return devices;
    }

    async _tcpScanSubnetSequential(subnet, port, subnetCount, onFound = null) {
        if (!this.CordovaSocket) return [];
        const found = [];
        const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
        for (let i = 0; i < ips.length; i++) {
            const pct = Math.round(((i + 1) / ips.length) * 100);
            this._setTelnetScanProgress(pct, `Scanning ${subnet}.x  ${pct}%  (port ${port})`);
            const result = await this._checkTelnetPortSequential(ips[i], port, 700);
            if (result && !found.includes(result)) {
                found.push(result);
                if (onFound) onFound(result);
            }
        }
        return found;
    }

    async _checkTelnetPortSequential(ip, port, timeout) {
        return new Promise((resolve) => {
            let resolved = false;
            let socket;
            try {
                socket = new this.CordovaSocket();
            } catch (e) {
                resolve(null);
                return;
            }

            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { socket.close(); } catch (e) {}
                    resolve(null);
                }
            }, timeout);

            const finish = (found) => {
                if (!resolved) {
                    clearTimeout(timer);
                    resolved = true;
                    try { socket.close(); } catch (e) {}
                    resolve(found ? ip : null);
                }
            };

            socket.onData = (data) => {
                if (!resolved) {
                    const text = new TextDecoder().decode(data);
                    if (
                        text.includes('GrblHAL') ||
                        text.includes('grbl') ||
                        text.includes('Ooznest') ||
                        text.includes('ok') ||
                        text.includes('<') ||
                        text.includes('[MSG:')
                    ) {
                        finish(true);
                    }
                }
            };

            socket.onError = () => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            };

            socket.onClose = () => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            };

            socket.open(ip, port, () => {
                try {
                    const probe = new TextEncoder().encode('\r\n?\r\n');
                    socket.write(probe, () => {}, () => {});
                } catch (e) {}
            }, (err) => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            });
        });
    }

    _autoConnectTelnet(ip) {
        console.log("Auto-connecting Telnet to", ip);
        const ipInput = document.getElementById('ip-telnet');
        const portInput = document.getElementById('port-telnet');
        if (ipInput) ipInput.value = ip;
        if (portInput) portInput.value = '23';

        this.type = 'telnet';
        this.saveSettings();
        this.modalController?.hide();
        this._showConnectingStatus(`Auto-connecting to ${ip}:23 (Telnet)...`);
        if (this.isCordova) {
            this._connectCordovaTelnet(ip, 23).catch(err => {
                console.error("Telnet auto-connect failed:", err);
            });
        } else {
            if (!this.backendWs) {
                this.connectToBackend().then(() => {
                    this.backendWs.send(JSON.stringify({ type: 'connect', connectionType: 'telnet', ip, port: 23 }));
                }).catch(err => {
                    console.error("Telnet auto-connect failed:", err);
                });
            } else {
                this.backendWs.send(JSON.stringify({ type: 'connect', connectionType: 'telnet', ip, port: 23 }));
            }
        }
    }

    _showDiscoveredDevices(devices) {
        const container = document.getElementById('discovered-devices');
        const list = document.getElementById('discovered-list');
        const statusEl = document.getElementById('discover-status');
        if (!container || !list) return;

        list.innerHTML = '';
        container.classList.remove('hidden');

        if (devices.length === 0) {
            const div = document.createElement('div');
            div.className = 'text-[10px] text-grey text-center py-2';
            div.textContent = 'No devices found.';
            list.appendChild(div);
            return;
        }

        for (const ip of devices) {
            this._appendDiscoveredDevice(ip);
        }
    }

    _appendDiscoveredDevice(ip) {
        if (!ip) return;
        const container = document.getElementById('discovered-devices');
        const list = document.getElementById('discovered-list');
        if (!container || !list) return;

        const existing = list.querySelector(`[data-ip="${ip}"]`);
        if (existing) return;

        const empty = Array.from(list.children).find(node => node.textContent === 'No devices found.');
        if (empty) empty.remove();

        container.classList.remove('hidden');

        const div = document.createElement('div');
        div.dataset.ip = ip;
        div.className = 'flex items-center justify-between gap-3 p-2 hover:bg-white rounded transition-colors border-b border-grey-light last:border-b-0';
        div.innerHTML = `
            <div class="flex flex-col min-w-0">
                <span class="text-xs font-bold text-secondary-dark">${ip}</span>
            </div>
            <button class="btn btn-primary h-8 px-3 text-[10px] font-bold shrink-0">Connect</button>
        `;
        div.querySelector('button')?.addEventListener('click', () => {
            const ipInput = document.getElementById('ip-telnet');
            if (ipInput) ipInput.value = ip;
            this._autoConnectTelnet(ip);
        });
        list.appendChild(div);
    }
}
