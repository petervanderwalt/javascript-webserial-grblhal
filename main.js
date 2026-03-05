const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const express = require('express');
const http = require('http');
const net = require('net');
const { SerialPort } = require('serialport');
const { WebSocketServer } = require('ws');

// Express App setup
const expressApp = express();
const port = 8081; // Pick a port for the internal server
expressApp.use(express.static(__dirname));

const server = http.createServer(expressApp);
const wss = new WebSocketServer({ server });

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

let activePort = null;
let activeSocket = null;

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
                const ports = await SerialPort.list();
                ws.send(JSON.stringify({ type: 'ports', data: ports }));
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
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
                    baudRate: parseInt(data.baud)
                });
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
                });
            } else if (data.connectionType === 'telnet') {
                activePort = net.connect(data.port || 23, data.ip);
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

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
