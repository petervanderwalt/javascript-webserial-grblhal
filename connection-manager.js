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
            // Show the native USB tab and default to it
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.remove('hidden');
            if (telnetTab) telnetTab.classList.add('hidden'); // telnet still hidden on mobile
            this.setConnectionType('usb');
        }, false);

        // UI initialization based on hosting environment
        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
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
            } else {
                this.setConnectionType('webserial');
            }
        }
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

        if (type === 'usb' && this.isElectron && !this.backendWs) {
            this.connectToBackend();
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
        if (this.type === 'webserial') {
            const baud = parseInt(document.getElementById('baud-webserial').value);
            await this.webSerial.connect(baud);
        } else if (this.type === 'usb') {
            if (!this.backendWs && !this.isCordova) await this.connectToBackend();
            const port = document.getElementById('port-node').value;
            const baud = parseInt(document.getElementById('baud-node').value);

            if (this.isCordova) {
                // cordovarduino requires decimal integers, NOT hex strings
                // VID 0x0483 = 1155, PID 0x5740 = 22336 (STMicroelectronics CDC)
                serial.requestPermission(
                    { vid: 1155, pid: 22336 },
                    () => {
                        serial.open(
                            { baudRate: baud, sleepOnPause: false },
                            () => {
                                console.log("Cordova Serial Open Success");
                                this.flowControl.reset();
                                this.handleConnect();
                            },
                            (err) => {
                                console.error("Cordova Serial Open Error:", err);
                                this.emit('error', new Error("Can't open port: " + err));
                            }
                        );
                    },
                    (err) => {
                        console.error("Cordova USB Permission Denied:", err);
                        this.emit('error', new Error("Permission denied: " + err));
                    });
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
}
