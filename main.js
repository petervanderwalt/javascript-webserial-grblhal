const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const net = require('net');
const os = require('os');
const { SerialPort } = require('serialport');
const { WebSocketServer } = require('ws');
const { autoUpdater } = require('electron-updater');
const { runFirmwareFlash } = require('./firmware-flash-backend.js');
const expressApp = express();
const port = 8081; // Pick a port for the internal server
expressApp.use(express.static(__dirname));

const server = http.createServer(expressApp);
const wss = new WebSocketServer({ server });

// Queue file paths that arrived before the renderer is ready
let pendingFile = null;

const GCODE_EXTS = ['.gcode', '.nc', '.gc', '.ngc'];

function isGcodeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return GCODE_EXTS.includes(ext);
}

function sendFileToRenderer(filePath) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
        pendingFile = filePath;
        return;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const filename = path.basename(filePath);
        wins[0].webContents.send('open-file', { content, filename, filePath });
    } catch (err) {
        console.error('Failed to read file:', filePath, err.message);
        wins[0].webContents.send('open-file', { error: err.message, filePath });
    }
}

// Single instance lock — subsequent launches pass their args to the running instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        const fileArg = argv.find(a => isGcodeFile(a));
        if (fileArg) sendFileToRenderer(path.resolve(fileArg));
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

// macOS: file dropped on dock icon when app is already running
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (isGcodeFile(filePath)) sendFileToRenderer(filePath);
});

// IPC Handlers for Window Controls
ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.minimize();
});

ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});

ipcMain.on('window-close', (event) => {
    app.quit();
});

ipcMain.handle('get-network-info', async () => {
    const interfaces = os.networkInterfaces();
    const results = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                results.push({
                    name,
                    address: iface.address,
                    netmask: iface.netmask,
                    cidr: iface.cidr
                });
            }
        }
    }
    return results;
});

let activePort = null;
let activeSocket = null;
let firmwareFlashInProgress = false;

function getActiveControllerHttpTarget () {
    if (status.comms.type !== 'telnet' || !status.comms.ip) {
        return null;
    }

    return {
        host: status.comms.ip,
        port: status.comms.httpPort || 80
    };
}

function proxyControllerRequest (req, res, controllerPath) {
    const target = getActiveControllerHttpTarget();

    if (!target) {
        res.status(503).json({
            status: 'error',
            message: 'No active Telnet controller with HTTP file access is available.'
        });
        return;
    }

    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    delete headers.connection;
    delete headers.origin;
    delete headers.referer;

    const proxyReq = http.request({
        host: target.host,
        port: target.port,
        method: req.method,
        path: controllerPath,
        headers
    }, (proxyRes) => {
        res.statusCode = proxyRes.statusCode || 502;

        Object.entries(proxyRes.headers).forEach(([key, value]) => {
            if (value !== undefined) {
                res.setHeader(key, value);
            }
        });

        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.status(502).json({
                status: 'error',
                message: `Controller HTTP proxy failed: ${err.message}`
            });
        } else {
            res.destroy(err);
        }
    });

    req.pipe(proxyReq);
}

expressApp.use((req, res, next) => {
    if (req.path === '/sdfiles' || req.path === '/upload' || req.path.startsWith('/sd/')) {
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        const controllerPath = req.path === '/sdfiles'
            ? `/sdfiles${query}`
            : req.path === '/upload'
                ? `/upload${query}`
                : `${req.path}${query}`;

        proxyControllerRequest(req, res, controllerPath);
        return;
    }

    next();
});

// Central Machine State (inspired by OpenBuilds CONTROL)
let status = {
    comms: {
        connected: false,
        type: null,
        port: null,
        baud: null,
        ip: null
    },
    machine: {
        status: 'Offline',
        wpos: { x: 0, y: 0, z: 0, a: 0 },
        mpos: { x: 0, y: 0, z: 0, a: 0 },
        feed: 0,
        spindle: 0,
        ov: [100, 100, 100],
        wcs: 'G54'
    },
    job: {
        active: false,
        name: null,
        currentLine: 0,
        totalLines: 0,
        pct: 0
    },
    gcode: {
        content: null,
        filename: null
    }
};

function broadcast(msg) {
    const json = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(json);
        }
    });
}

function updateStatus(path, value) {
    const parts = path.split('.');
    let target = status;
    for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
    // Broadcast the change to all clients
    broadcast({ type: 'statusUpdate', path: path, value: value });
}

// Simple Status Report Parser
function parseStatusReport(line) {
    if (!line.startsWith('<') || !line.endsWith('>')) return;
    const inner = line.substring(1, line.length - 1);
    const parts = inner.split('|');

    updateStatus('machine.status', parts[0]);

    parts.forEach(p => {
        if (p.startsWith('WPos:')) {
            const coords = p.substring(5).split(',');
            updateStatus('machine.wpos', {
                x: parseFloat(coords[0]),
                y: parseFloat(coords[1]),
                z: parseFloat(coords[2]),
                a: coords[3] ? parseFloat(coords[3]) : 0
            });
        }
        else if (p.startsWith('MPos:')) {
            const coords = p.substring(5).split(',');
            updateStatus('machine.mpos', {
                x: parseFloat(coords[0]), y: parseFloat(coords[1]), z: parseFloat(coords[2]),
                a: coords[3] ? parseFloat(coords[3]) : 0
            });
        }
        else if (p.startsWith('FS:')) {
            const fs = p.substring(3).split(',');
            updateStatus('machine.feed', parseFloat(fs[0]));
            updateStatus('machine.spindle', parseFloat(fs[1]));
        }
        else if (p.startsWith('Ov:')) {
            const ov = p.substring(3).split(',');
            updateStatus('machine.ov', ov.map(v => parseInt(v)));
        }
        else if (p.startsWith('WCS:')) {
            updateStatus('machine.wcs', p.substring(4));
        }
        else if (p.startsWith('Pn:')) {
            updateStatus('machine.pins', p.substring(3));
        }
    });
}

wss.on('connection', (ws) => {
    console.log('Frontend connected to Backend WebSocket');

    // Send initial state to new client
    ws.send(JSON.stringify({ type: 'syncStatus', status: status }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        handleMessage(data, ws);
    });

    ws.on('close', () => {
        console.log('Frontend disconnected');
    });
});

async function handleMessage(data, ws) {
    switch (data.type) {
        case 'listPorts':
            try {
                const ports = (await SerialPort.list()).filter(port => {
                    const path = (port.path || '').toUpperCase();
                    return path !== 'COM1' && path !== 'COM2';
                });
                ws.send(JSON.stringify({ type: 'ports', data: ports }));
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
            }
            break;

        case 'scanTelnet':
            try {
                const scanPort = data.port || 23;
                const devices = await scanTelnetNetwork(scanPort, ws, data.subnet || null);
                ws.send(JSON.stringify({ type: 'scanTelnetResult', devices }));
            } catch (err) {
                ws.send(JSON.stringify({ type: 'scanTelnetResult', devices: [], error: err.message }));
            }
            break;

        case 'connect':
            if (activePort) {
                try {
                    if (activePort.close) activePort.close();
                    if (activePort.destroy) activePort.destroy();
                } catch (e) { }
            }

            console.log("Connecting via", data.connectionType, "to", data.port || data.ip);

            const sendData = (chunk) => {
                const str = chunk.toString();
                // Accumulate data and split by lines for parsing
                this._accumulator = (this._accumulator || '') + str;
                const lines = this._accumulator.split('\n');
                this._accumulator = lines.pop();

                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('<')) parseStatusReport(trimmed);
                });

                broadcast({
                    type: 'data',
                    data: chunk.toString('base64'),
                    encoding: 'base64'
                });
            };

            if (data.connectionType === 'usb') {
                activePort = new SerialPort({
                    path: data.port,
                    baudRate: parseInt(data.baud),
                    autoOpen: false
                });

                activePort.on('error', (err) => {
                    console.error("SerialPort Error:", err);
                    ws.send(JSON.stringify({ type: 'error', message: `Port Error: ${err.message}` }));
                    updateStatus('comms.connected', false);
                    broadcast({ type: 'disconnected' });
                    
                    // Release the OS file handle so closing/reconnecting works natively
                    if (activePort) {
                        try {
                            if (activePort.close && activePort.isOpen) activePort.close();
                            if (activePort.destroy) activePort.destroy();
                        } catch (e) {}
                        activePort = null;
                    }
                });

                activePort.open();

                activePort.on('open', () => {
                    updateStatus('comms.connected', true);
                    updateStatus('comms.type', 'usb');
                    updateStatus('comms.port', data.port);
                    updateStatus('comms.baud', data.baud);
                    broadcast({ type: 'connected' });
                });
                activePort.on('data', sendData);
                activePort.on('close', () => {
                    updateStatus('comms.connected', false);
                    broadcast({ type: 'disconnected' });
                    // Nullify so it doesn't get used again improperly
                    if (activePort) activePort = null; 
                });
            } else if (data.connectionType === 'telnet') {
                activePort = net.connect(data.port || 23, data.ip);
                
                activePort.on('error', (err) => {
                    console.error("Telnet Error:", err);
                    ws.send(JSON.stringify({ type: 'error', message: `Telnet Error: ${err.message}` }));
                    updateStatus('comms.connected', false);
                    broadcast({ type: 'disconnected' });

                    if (activePort) {
                        try {
                            if (activePort.destroy) activePort.destroy();
                        } catch (e) {}
                        activePort = null;
                    }
                });

                activePort.on('connect', () => {
                    updateStatus('comms.connected', true);
                    updateStatus('comms.type', 'telnet');
                    updateStatus('comms.ip', data.ip);
                    updateStatus('comms.port', data.port);
                    broadcast({ type: 'connected' });
                });
                activePort.on('data', sendData);
                activePort.on('close', () => {
                    updateStatus('comms.connected', false);
                    broadcast({ type: 'disconnected' });
                    if (activePort) activePort = null;
                });
            }
            break;

        case 'write':
            if (activePort) {
                const buffer = data.encoding === 'base64'
                    ? Buffer.from(data.data, 'base64')
                    : Buffer.from(data.data);
                activePort.write(buffer);
            }
            break;

        case 'disconnect':
            if (activePort) {
                if (activePort.close) activePort.close();
                if (activePort.destroy) activePort.destroy();
                activePort = null;
            }
            break;

        case 'firmwareFlash':
            if (firmwareFlashInProgress) {
                ws.send(JSON.stringify({ type: 'firmwareFlashError', message: 'A firmware flash is already in progress.' }));
                break;
            }

            firmwareFlashInProgress = true;
            try {
                const result = await runFirmwareFlash({
                    baseDir: __dirname,
                    firmwareKey: data.firmwareKey,
                    previousPort: data.previousPort,
                    programmingPort: data.programmingPort,
                    log: (line) => ws.send(JSON.stringify({ type: 'firmwareFlashLog', line })),
                    progress: (percent) => ws.send(JSON.stringify({ type: 'firmwareFlashProgress', percent })),
                    beforeFlashClose: async () => {
                        if (!activePort) return;
                        const portToClose = activePort;
                        activePort = null;
                        try {
                            if (portToClose.close) {
                                await new Promise((resolve) => portToClose.close(() => resolve()));
                            }
                        } catch (_) {
                            // Best-effort close before flashing.
                        }
                        try {
                            if (portToClose.destroy) portToClose.destroy();
                        } catch (_) {
                            // Ignore destroy errors.
                        }
                    }
                });

                ws.send(JSON.stringify({ type: 'firmwareFlashComplete', ...result }));
            } catch (error) {
                ws.send(JSON.stringify({
                    type: 'firmwareFlashError',
                    message: error?.message || String(error)
                }));
            } finally {
                firmwareFlashInProgress = false;
            }
            break;

        case 'loadGCode':
            updateStatus('gcode.content', data.content);
            updateStatus('gcode.filename', data.filename);
            broadcast({ type: 'gcodeLoaded', filename: data.filename, content: data.content });
            break;

        case 'updateJob':
            updateStatus('job.active', data.active);
            updateStatus('job.currentLine', data.currentLine);
            updateStatus('job.totalLines', data.totalLines);
            updateStatus('job.pct', data.pct);
            break;
    }
}

server.listen(port, '0.0.0.0', () => {
    console.log(`Internal server running at http://0.0.0.0:${port}`);
});

// --- Telnet Network Scanning (Electron backend) ---

function _getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}

function _checkTelnetPort(ip, port, timeout) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);
        let settled = false;
        const finish = (found) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(found ? ip : null);
        };
        socket.on('connect', () => {
            let data = '';
            try {
                socket.write('\r\n?\r\n');
            } catch (e) {}
            socket.on('data', (chunk) => {
                data += chunk.toString();
                if (
                    data.includes('GrblHAL') ||
                    data.includes('Grbl') ||
                    data.includes('grbl') ||
                    data.includes('Ooznest') ||
                    data.includes('ok') ||
                    data.includes('<') ||
                    data.includes('[MSG:')
                ) {
                    finish(true);
                }
            });
            setTimeout(() => {
                if (!settled) finish(false);
            }, Math.max(500, timeout - 100));
        });
        socket.on('error', () => { if (!settled) finish(false); });
        socket.on('timeout', () => { if (!settled) finish(false); });
        socket.connect(port, ip);
    });
}

function _scanSubnet(subnet, port, onProgress) {
    return new Promise((resolve) => {
        let idx = 0;
        const next = () => {
            if (idx >= 254) return resolve();
            idx++;
            if (onProgress) onProgress(idx, 254);
            _checkTelnetPort(`${subnet}.${idx}`, port, 300).then(ip => {
                if (ip) {
                    resolve(ip);
                } else {
                    setImmediate(next);
                }
            });
        };
        next();
    });
}

async function scanTelnetNetwork(port, ws, subnetOverride = null) {
    port = port || 23;
    const subnets = [];
    if (subnetOverride) {
        subnets.push(subnetOverride);
    } else {
        const localIP = _getLocalIP();
        if (localIP) {
            const parts = localIP.split('.');
            subnets.push(parts.slice(0, 3).join('.'));
        }
    }
    if (subnets.length === 0) {
        subnets.push('192.168.0', '192.168.1', '192.168.4', '10.0.0');
    }
    const total = subnets.length * 254;
    let scanned = 0;
    const found = [];
    for (const subnet of subnets) {
        for (let host = 1; host < 255; host++) {
            scanned++;
            const pct = Math.min(Math.round((scanned / total) * 100), 99);
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'scanTelnetProgress', percent: pct, message: `Scanning ${subnet}.x  ${pct}%  (port ${port})` }));
            }
            const ip = await _checkTelnetPort(`${subnet}.${host}`, port, 300);
            if (ip && !found.includes(ip)) {
                found.push(ip);
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'scanTelnetFound', ip }));
                }
            }
        }
    }
    return found;
}

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        frame: false, // HIDE DEFAULT WINDOW FRAME
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        autoHideMenuBar: true,
        title: "grblHAL Web (Electron)",
        icon: path.join(__dirname, 'cordova', 'resources', 'icon.png')
    });

    mainWindow.maximize();

    // Handle beforeunload properly in Electron
    mainWindow.webContents.on('will-prevent-unload', (event) => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Disconnect and Close', 'Cancel'],
            title: 'Active Connection',
            message: 'You are currently connected to the CNC machine. Are you sure you want to disconnect and close the application?',
            defaultId: 1,
            cancelId: 1
        });

        if (choice === 0) {
            event.preventDefault(); // Allows the unload to proceed
        }
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}`);

    // When the window is ready, send any queued or argv file to the renderer
    mainWindow.webContents.on('did-finish-load', () => {
        // File passed as command-line argument (file association / double-click)
        const fileArg = process.argv.find(a => isGcodeFile(a));
        const fileToOpen = pendingFile || (fileArg ? path.resolve(fileArg) : null);
        if (fileToOpen) {
            sendFileToRenderer(fileToOpen);
            pendingFile = null;
        }
    });

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()
}

app.whenReady().then(() => {
    // Auto-Updater Logic
    let updateDownloadWatchdog = null;
    let updateCheckStarted = false;
    const updateEvents = new Map();
    const sendUpdateEvent = (channel, payload) => {
        updateEvents.set(channel, payload);
        BrowserWindow.getAllWindows().forEach(win => win.webContents.send(channel, payload));
    };
    const replayUpdateEvents = (webContents) => {
        ['update-checking', 'update-available', 'update-download-progress', 'update-download-timeout', 'update-error', 'update-downloaded', 'update-not-available']
            .forEach(channel => {
                if (updateEvents.has(channel)) webContents.send(channel, updateEvents.get(channel));
            });
    };
    const clearUpdateDownloadWatchdog = () => {
        if (updateDownloadWatchdog) clearTimeout(updateDownloadWatchdog);
        updateDownloadWatchdog = null;
    };
    const armUpdateDownloadWatchdog = () => {
        clearUpdateDownloadWatchdog();
        updateDownloadWatchdog = setTimeout(() => {
            sendUpdateEvent('update-download-timeout', {
                message: 'No update download progress has been received for two minutes. Check your internet connection and try restarting the app.'
            });
        }, 120000);
    };

    autoUpdater.on('update-available', (info) => {
        sendUpdateEvent('update-available', info);
        armUpdateDownloadWatchdog();
    });
    autoUpdater.on('download-progress', (progress) => {
        sendUpdateEvent('update-download-progress', progress);
        armUpdateDownloadWatchdog();
    });
    autoUpdater.on('update-downloaded', (info) => {
        clearUpdateDownloadWatchdog();
        sendUpdateEvent('update-downloaded', info);
    });
    autoUpdater.on('error', (err) => {
        clearUpdateDownloadWatchdog();
        console.error('Auto-updater error:', err.message || err);
        sendUpdateEvent('update-error', { message: err.message || String(err) });
    });
    autoUpdater.on('update-not-available', (info) => {
        sendUpdateEvent('update-not-available', info);
    });

    ipcMain.on('updater-ready', (event) => {
        replayUpdateEvents(event.sender);
        if (updateCheckStarted) return;

        updateCheckStarted = true;
        sendUpdateEvent('update-checking', { message: 'Checking for updates...' });
        autoUpdater.checkForUpdatesAndNotify().catch(err => {
            console.error('Auto-update check failed:', err.message);
            sendUpdateEvent('update-error', { message: err.message || String(err) });
        });
    });

    ipcMain.on('install-update', () => {
        autoUpdater.quitAndInstall();
    });

    createWindow();

    // Renderer asks to open a G-code file via native dialog
    ipcMain.handle('load-gcode-dialog', async () => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length === 0) return null;
        const result = await dialog.showOpenDialog(wins[0], {
            title: 'Open G-Code File',
            filters: [
                { name: 'G-Code Files', extensions: ['gcode', 'nc', 'gc', 'ngc'] },
                { name: 'All Files', extensions: ['*'] }
            ],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        const filePath = result.filePaths[0];
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return { content, filename: path.basename(filePath), filePath };
        } catch (err) {
            return { error: err.message, filePath };
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
