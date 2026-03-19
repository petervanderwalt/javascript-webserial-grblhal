import { GrblFlowControl } from './grbl-flow-control.js';

export class ConnectionManager {
    constructor(webSerial) {
        this.webSerial = webSerial;
        this.flowControl = new GrblFlowControl(this);
        this.type = 'webserial'; // 'webserial', 'usb', 'telnet'
        this.backendWs = null;
        // Detect if we are hosted by our Node.js/Electron backend
        this.isElectron = window.electron !== undefined;
        // isCordova is checked dynamically since cordova.js loads async
        this.hasBackend = this.isElectron || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '8081');
        this.httpBaseUrl = null;
        this._scanning = false;

        this.listeners = {
            connect: [],
            disconnect: [],
            line: [],
            sent: [],
            error: []
        };

        // UI element references
        this.modal = document.getElementById('connection-modal');
        this.btnConnect = document.getElementById('btn-connect');

        // Expose globals for UI callbacks
        window.toggleConnectionModal = () => this.toggleModal();
        window.setConnectionType = (type) => this.setConnectionType(type);
        window.handleConnectClick = () => this.connect();
        window.refreshNodePorts = () => this.refreshNodePorts();

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

        // Intercept connect button click
        if (this.btnConnect) {
            this.btnConnect.onclick = () => {
                if (this.isConnected) {
                    this.disconnect();
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
            this.hasBackend = true; // Cordova counts as a backend
            this.initCordova();
            // Re-run UI setup now that we know we're in Cordova
            // Show the native USB tab
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.remove('hidden');
            if (telnetTab) telnetTab.classList.add('hidden'); // telnet still hidden on mobile
            this.setConnectionType('websocket');
        }, false);

        // UI initialization based on hosting environment
        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
            this.setConnectionType('usb');
        }

        if (!this.hasBackend) {
            // Hide Node-only options in browser when not hosted by local backend
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');

            // If hosted directly on grblHAL (via hardware IP, not localhost), default to websocket
            if (window.location.protocol === 'http:' && window.location.port !== '8081' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                this.setConnectionType('websocket');
                const wsUrlInput = document.getElementById('url-websocket');
                if (wsUrlInput) {
                    wsUrlInput.value = `ws://${window.location.hostname}:81/ws`; // Assuming default networking plugin port
                }
                this.httpBaseUrl = window.location.origin;
            } else {
                this.setConnectionType('webserial');
            }
        }
    }

    saveSettings() {
        try {
            const settings = {
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
        try {
            const stored = localStorage.getItem('cnc_connection_settings');
            if (stored) return JSON.parse(stored);
        } catch (e) {
            console.error("Error loading connection settings:", e);
        }
        return null;
    }

    toggleModal() {
        if (!this.modal) return;
        this.modal.classList.toggle('hidden');

        // If showing USB tab and in Electron, refresh ports
        if (!this.modal.classList.contains('hidden') && this.type === 'usb' && this.isElectron) {
            this.refreshNodePorts();
        }

        // Auto-hide Node/Telnet tabs if no backend detected
        if (!this.hasBackend) {
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');
            if (this.type !== 'websocket') {
                this.setConnectionType('webserial');
            }
        } else if (this.isElectron) {
            // Show title bar in Electron
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
        }
    }

    setConnectionType(type) {
        this.type = type;

        // Update Tabs
        ['webserial', 'usb', 'telnet', 'websocket'].forEach(t => {
            const tab = document.getElementById(`tab-${t}`);
            const config = document.getElementById(`config-${t}`);
            if (!tab || !config) return;

            if (t === type) {
                tab.classList.add('bg-white', 'shadow-sm', 'text-secondary-dark');
                tab.classList.remove('text-grey');
                config.classList.remove('hidden');

                if (type === 'usb' && this.isCordova) {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.add('hidden');
                } else if (type === 'usb') {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.remove('hidden');
                }
            } else {
                tab.classList.remove('bg-white', 'shadow-sm', 'text-secondary-dark');
                tab.classList.add('text-grey');
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
        if (!window.serial) {
            console.error("Cordova Serial plugin not available");
            return;
        }

        // Auto-refresh ports or just show UI
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
                this.emit('error', new Error("Serial Read Error: " + err));
            }
        );
    }

    handleBackendMessage(msg) {
        switch (msg.type) {
            case 'ports':
                const select = document.getElementById('port-node');
                if (select) {
                    select.innerHTML = msg.data.map(p => `<option value="${p.path}">${p.friendlyName || p.path}</option>`).join('');
                    const saved = this.loadSettings();
                    if (saved && saved.usbPort) {
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
            case 'error':
                this.emit('error', new Error(msg.message));
                break;
        }
    }

    async refreshNodePorts() {
        if (!this.backendWs) await this.connectToBackend();
        this.backendWs.send(JSON.stringify({ type: 'listPorts' }));
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

            if (this.isCordova) {
                // Supported devices: STM32 (1155:22336) and ESP32-S3 (12346:16385)
                const supportedDevices = [
                    { vid: 1155, pid: 22336, name: 'STM32' },
                    { vid: 12346, pid: 16385, name: 'ESP32-S3' }
                ];

                const tryConnect = (index) => {
                    if (index >= supportedDevices.length) {
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
                                        this.emit('error', new Error("Can't open port: " + err));
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
            if (!this.backendWs) await this.connectToBackend();
            const ip = document.getElementById('ip-telnet').value;
            const port = parseInt(document.getElementById('port-telnet').value);
            this.backendWs.send(JSON.stringify({
                type: 'connect',
                connectionType: 'telnet',
                ip: ip,
                port: port
            }));
        } else if (this.type === 'websocket') {
            const url = document.getElementById('url-websocket').value || `ws://${window.location.hostname}:81/ws`;
            this.directWs = new WebSocket(url);

            this.directWs.onopen = () => {
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
                console.error("Direct WebSocket Error:", err);
                this.emit('error', new Error("WebSocket Error"));
            };

            this.directWs.onclose = () => {
                console.log("Direct WebSocket Closed");
                if (this.isConnected) this.handleDisconnect();
            };
        }
        this.modal.classList.add('hidden');
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

    disconnect() {
        if (this.type === 'webserial') {
            this.webSerial.disconnect();
        } else if (this.type === 'websocket' && this.directWs) {
            this.directWs.close();
            this.directWs = null;
        } else if (this.backendWs) {
            this.backendWs.send(JSON.stringify({ type: 'disconnect' }));
        }
    }

    handleConnect() {
        this.isConnected = true;
        this.emit('connect');
    }

    handleDisconnect() {
        this.isConnected = false;
        this.emit('disconnect');
    }

    // --- Data Transmission ---

    async sendCommand(line) {
        if (this.type === 'webserial') {
            await this.webSerial.sendCommand(line);
        } else if (this.isCordova && window.serial) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.backendWs) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        }
    }

    async sendRealtime(char) {
        if (this.type === 'webserial') {
            await this.webSerial.sendRealtime(char);
        } else if (this.isCordova && window.serial) {
            // Drop realtime char if port is actively writing to prevent queue flooding
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
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(char);
        } else if (this.backendWs) {
            this.backendWs.send(JSON.stringify({ type: 'write', data: char }));
        }
    }

    async writeRaw(data) {
        if (this.type === 'webserial') {
            await this.webSerial.writeRaw(data);
        } else if (this.isCordova && window.serial) {
            // Lock to prevent concurrent ThreadPool exhaustion
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
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(new Uint8Array(data));
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

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
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
                ips.forEach(ip => {
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
            <i class="bi bi-chevron-right text-grey group-hover:text-primary transition-colors"></i>
        `;
        div.onclick = () => {
            const urlInput = document.getElementById('url-websocket');
            if (urlInput) {
                urlInput.value = `ws://${res.ip}:81/ws`;
            }
            // Auto-hide results
            resultsDiv.classList.add('hidden');
        };
        resultsDiv.appendChild(div);
    }
}
