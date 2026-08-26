import { makeLine, getTextWidth, drawTextString } from './gcode-draw.js';

export class SpoilboardGridHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;
        this.setup = {
            home: false,
            z: false
        };
        this.pendingHomeAll = false;
        this.pendingHomeAllMotion = false;
        this.pendingZProbe = false;
        this.pendingZProbeMotion = false;
        window.addEventListener('machine-state-changed', (e) => this.handleSetupMachineState(e.detail?.state || ''));
        window.addEventListener('machine-connection-changed', (e) => this.handleSetupConnectionState(!!e.detail?.connected));

        setTimeout(() => {
            this.syncAutoDimensions({ silent: true });
            this.updateSetupUI();
        }, 0);
    }

    getMaxTravelDimensions() {
        const settings = window.grblSettings?.settings || {};
        const xTravel = parseFloat(settings['130']?.val);
        const yTravel = parseFloat(settings['131']?.val);

        if (!Number.isFinite(xTravel) || !Number.isFinite(yTravel) || xTravel <= 0 || yTravel <= 0) {
            return null;
        }

        return {
            width: Math.round(xTravel),
            height: Math.round(yTravel)
        };
    }

    syncAutoDimensions({ silent = false } = {}) {
        const dims = this.getMaxTravelDimensions();
        if (!dims) {
            if (!silent && this.term) this.term.writeln('\x1b[33m[Spoilboard Grid] Machine max travel settings are not available.\x1b[0m');
            return false;
        }

        const widthInput = document.getElementById('sg-width');
        const heightInput = document.getElementById('sg-height');
        if (!widthInput || !heightInput) return false;

        widthInput.value = dims.width;
        heightInput.value = dims.height;

        if (!silent && this.term) {
            this.term.writeln(`\x1b[32m[Spoilboard Grid] Using machine max travel: ${dims.width}x${dims.height}mm\x1b[0m`);
        }
        return true;
    }

    autoSpoilboard() {
        return this.syncAutoDimensions();
    }

    updateCoordinateInfo() {
        // Kept for older inline handlers; Spoilboard Grid now uses one automatic XY setup mode.
    }

    generateGrid() {
        if (!window.ws?.isConnected) {
            if (window.showToast) window.showToast('Connect before generating the spoilboard grid', 'plug-zap', 'warning');
            return;
        }
        if (!this.isSetupComplete()) {
            if (window.showToast) window.showToast('Complete spoilboard setup first', 'list-checks', 'warning');
            return;
        }

        this.syncAutoDimensions({ silent: true });
        this.updateCoordinateInfo();

        const widthX = parseFloat(document.getElementById('sg-width').value) || 300;
        const heightY = parseFloat(document.getElementById('sg-height').value) || 300;
        const gridSpacing = parseFloat(document.getElementById('sg-spacing').value) || 50;
        const includeRuler = document.getElementById('sg-ruler').checked;

        const depth = parseFloat(document.getElementById('sg-depth').value) || -0.3;
        const up = parseFloat(document.getElementById('sg-up').value) || 1;
        const feedrate = parseFloat(document.getElementById('sg-feed').value) || 500;
        const plungeRate = parseFloat(document.getElementById('sg-plunge').value) || 100;
        const spindleRpm = Math.max(0, parseFloat(document.getElementById('sg-rpm')?.value) || 0);

        const down = depth;
        const rapide = 'G0';
        const lent = 'G01';

        // Font sizing (hardcoded defaults — good for spoilboard engraving)
        const lengthLet = 3;
        const hightLet = 4;
        const space = 1.5;
        const gridScaleFactor = 0.7;
        const gridLengthLet = lengthLet * gridScaleFactor;
        const gridHightLet = hightLet * gridScaleFactor;
        const gridSpace = space * gridScaleFactor;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const worstCaseLabelRight = Math.round(heightY).toString();
        const maxLabelWidthRight = getTextWidth(worstCaseLabelRight, gridLengthLet, gridSpace);

        const rightReserve = includeRuler ? (gridHightLet + maxLabelWidthRight + 2.0) : 0;
        const topReserve = includeRuler ? (gridHightLet + gridHightLet + 2.0) : 0;

        const X_grid_min = 0;
        const Y_grid_min = 0;
        const X_grid_max = Math.max(X_grid_min, widthX - rightReserve);
        const Y_grid_max = Math.max(Y_grid_min, heightY - topReserve);

        if (X_grid_max <= X_grid_min || Y_grid_max <= Y_grid_min) {
            if (window.showToast) window.showToast('Increase the spoilboard size or disable rulers to fit the grid', 'ruler', 'warning');
            return;
        }

        const xyZeroCommand = this.getSpoilboardXYZeroCommand(widthX, heightY, 1);
        if (xyZeroCommand) window.sendCmd(xyZeroCommand);

        let gcode = '';
        gcode += `; Spoilboard Grid\n`;
        gcode += `; Home the machine and set Z zero before running.\n`;
        gcode += `G21 G90 G17 G54 F${feedrate}\n`;
        gcode += `${this.getSpoilboardXYZeroCommand(widthX, heightY, 1)}\n`;
        if (spindleRpm > 0) gcode += `M3 S${spindleRpm}\n`;
        gcode += `G0 Z${up.toFixed(3)}\n`;

        // 1. Outer boundary frame
        gcode += makeLine(rapide, 'X', X_grid_min, Y_grid_min, { z: up });
        gcode += makeLine(lent, 'X', X_grid_min, Y_grid_min, { z: down, f: plungeRate });
        gcode += makeLine(lent, 'X', X_grid_max, Y_grid_min, { z: down, f: plungeRate });
        gcode += makeLine(lent, 'X', X_grid_max, Y_grid_max, { z: down, f: plungeRate });
        gcode += makeLine(lent, 'X', X_grid_min, Y_grid_max, { z: down, f: plungeRate });
        gcode += makeLine(lent, 'X', X_grid_min, Y_grid_min, { z: down, f: plungeRate });
        gcode += makeLine(rapide, 'X', X_grid_min, Y_grid_min, { z: up });

        // 2. Internal vertical grid lines
        for (let X = X_grid_min + gridSpacing; X <= X_grid_max - 1.0; X += gridSpacing) {
            gcode += makeLine(rapide, 'X', X, Y_grid_min, { z: up });
            gcode += makeLine(lent, 'X', X, Y_grid_min, { z: down, f: plungeRate });
            gcode += makeLine(lent, 'X', X, Y_grid_max, { z: down, f: plungeRate });
            gcode += makeLine(rapide, 'X', X, Y_grid_max, { z: up });
        }

        // 3. Internal horizontal grid lines
        for (let Y = Y_grid_min + gridSpacing; Y <= Y_grid_max - 1.0; Y += gridSpacing) {
            gcode += makeLine(rapide, 'X', X_grid_min, Y, { z: up });
            gcode += makeLine(lent, 'X', X_grid_min, Y, { z: down, f: plungeRate });
            gcode += makeLine(lent, 'X', X_grid_max, Y, { z: down, f: plungeRate });
            gcode += makeLine(rapide, 'X', X_grid_max, Y, { z: up });
        }

        // 4. Outward-facing rulers above and to the right of the grid
        if (includeRuler) {
            // Right edge ruler (along Y axis, ticks point right)
            const totalTicksY = Math.round(Y_grid_max - Y_grid_min);
            for (let i = 0; i <= totalTicksY; i++) {
                const Y = Y_grid_min + i;
                let tickHeight = gridHightLet * 0.4;
                let isMajor = false;
                if (i % 10 === 0) {
                    tickHeight = gridHightLet;
                    isMajor = true;
                } else if (i % 5 === 0) {
                    tickHeight = gridHightLet * 0.65;
                }

                gcode += makeLine(rapide, 'X', X_grid_max, Y, { z: up });
                gcode += makeLine(lent, 'X', X_grid_max, Y, { z: down, f: plungeRate });
                gcode += makeLine(lent, 'X', X_grid_max + tickHeight, Y, { z: down, f: plungeRate });
                gcode += makeLine(rapide, 'X', X_grid_max + tickHeight, Y, { z: up });

                if (isMajor) {
                    const labelText = i.toString();
                    const yBaseline = clamp(Y - (gridHightLet / 2), 0, heightY - gridHightLet);
                    const xBaseline = X_grid_max + tickHeight + 1.5;
                    gcode += drawTextString(labelText, xBaseline, yBaseline, gridLengthLet, gridHightLet, gridSpace, depth, up, 'X', false);
                }
            }

            // Top edge ruler (along X axis, ticks point up)
            const totalTicksX = Math.round(X_grid_max - X_grid_min);
            for (let i = 0; i <= totalTicksX; i++) {
                const X = X_grid_min + i;
                let tickHeight = gridHightLet * 0.4;
                let isMajor = false;
                if (i % 10 === 0) {
                    tickHeight = gridHightLet;
                    isMajor = true;
                } else if (i % 5 === 0) {
                    tickHeight = gridHightLet * 0.65;
                }

                gcode += makeLine(rapide, 'X', X, Y_grid_max, { z: up });
                gcode += makeLine(lent, 'X', X, Y_grid_max, { z: down, f: plungeRate });
                gcode += makeLine(lent, 'X', X, Y_grid_max + tickHeight, { z: down, f: plungeRate });
                gcode += makeLine(rapide, 'X', X, Y_grid_max + tickHeight, { z: up });

                if (isMajor) {
                    const labelText = i.toString();
                    const labelWidth = getTextWidth(labelText, gridLengthLet, gridSpace);
                    const xStart = clamp(X - (labelWidth / 2), 0, widthX - labelWidth);
                    const yBaseline = clamp(Y_grid_max + tickHeight + 1.5, 0, heightY - gridHightLet);
                    gcode += drawTextString(labelText, xStart, yBaseline, gridLengthLet, gridHightLet, gridSpace, depth, up, 'X', false);
                }
            }
        }

        // Return safe home
        gcode += makeLine(rapide, 'X', 0, 0, { z: up });
        gcode += 'M5\n';

        // Load into editor (via event)
        const event = new CustomEvent('gcode-loaded', { detail: { content: gcode, filename: 'Spoilboard_Grid.gcode' } });
        window.dispatchEvent(event);

        // Load into 3D viewer
        window.viewer.processGCodeString(gcode, 'Spoilboard_Grid.gcode parsed');

        // Switch to 3D view tab
        const viewerTab = document.querySelector("button[onclick*='viewer-view']");
        if (viewerTab) viewerTab.click();

        this.term.writeln(`\x1b[34m[Spoilboard Grid] Generated ${widthX}x${heightY}mm grid at ${gridSpacing}mm spacing.\x1b[0m`);
        this.term.writeln(`\x1b[32m[Spoilboard Grid] ${includeRuler ? 'With' : 'Without'} outward-facing rulers.\x1b[0m`);
        this.term.writeln('\x1b[32m[Spoilboard Grid] G-code loaded into viewer.\x1b[0m');
    }

    markSetupStep(step) {
        if (!Object.prototype.hasOwnProperty.call(this.setup, step)) return;
        this.setup[step] = true;
        this.updateSetupUI();
    }

    handleSetupMachineState(state) {
        const s = String(state || '').toLowerCase();
        if (this.pendingHomeAll && (s.startsWith('home') || s.startsWith('run'))) {
            this.pendingHomeAllMotion = true;
        }
        if ((this.pendingHomeAll || this.pendingZProbe) && s.startsWith('alarm')) {
            this.pendingHomeAll = false;
            this.pendingHomeAllMotion = false;
            this.pendingZProbe = false;
            this.pendingZProbeMotion = false;
            this.updateSetupUI();
            if (window.showToast) window.showToast('Setup action stopped by machine alarm', 'alert-triangle', 'error');
            return;
        }
        if (this.pendingHomeAll && this.pendingHomeAllMotion && s === 'idle') {
            this.pendingHomeAll = false;
            this.pendingHomeAllMotion = false;
            this.updateSetupUI();
        }
        if (this.pendingZProbe && s.startsWith('run')) {
            this.pendingZProbeMotion = true;
        }
        if (this.pendingZProbe && this.pendingZProbeMotion && s === 'idle') {
            this.pendingZProbe = false;
            this.pendingZProbeMotion = false;
            this.setup.z = true;
            this.updateSetupUI();
            if (window.showToast) window.showToast('Z zero set. Setup complete.', 'check-circle', 'success');
        }
    }

    handleSetupConnectionState(connected) {
        if (!connected) {
            this.pendingHomeAll = false;
            this.pendingHomeAllMotion = false;
            this.pendingZProbe = false;
            this.pendingZProbeMotion = false;
        }
        this.updateSetupUI();
    }

    setZZero() {
        if (!window.ws || !window.ws.isConnected) {
            if (window.showToast) window.showToast('Connect before setting Z zero', 'plug-zap', 'warning');
            return;
        }

        this.setup.z = true;
        this.updateSetupUI();
        if (window.showToast) window.showToast('Z zero confirmed. Setup complete.', 'check-circle', 'success');
    }

    getSpoilboardXYZeroCommand(width, height, workCoordinate = this.getActiveWcsP()) {
        const x = -Math.abs(Number(width) || 0);
        const y = -Math.abs(Number(height) || 0);
        if (!x || !y) return null;

        return `G21 G10 L2 P${workCoordinate} X${x.toFixed(3)} Y${y.toFixed(3)}`;
    }

    getActiveWcsP() {
        if (window.lastStatus) {
            const match = window.lastStatus.match(/WCS:G(\d+)/);
            if (match) {
                const val = parseInt(match[1], 10);
                if (val >= 54 && val <= 59) return val - 53;
            }
        }
        return 1;
    }

    isSetupComplete() {
        return this.setup.home && this.setup.z;
    }

    updateSetupUI() {
        const isConnected = !!window.ws?.isConnected;
        const nextStep = ['home', 'z'].find(step => !this.setup[step]);
        const connectBtn = document.getElementById('sg-setup-connect-btn');
        const homeBtn = document.getElementById('sg-setup-home-btn');
        const zActions = document.getElementById('sg-setup-z-actions');
        const zBtn = document.getElementById('sg-setup-z-btn');
        if (connectBtn) {
            connectBtn.classList.toggle('hidden', isConnected);
            connectBtn.classList.toggle('is-next', !isConnected);
        }
        if (homeBtn) {
            homeBtn.classList.toggle('hidden', !isConnected || nextStep !== 'home');
            homeBtn.classList.toggle('is-next', isConnected && nextStep === 'home');
            homeBtn.textContent = 'Confirm Homed';
        }
        if (zActions) zActions.classList.toggle('hidden', !isConnected || nextStep !== 'z');
        if (zBtn) zBtn.classList.toggle('is-next', isConnected && nextStep === 'z');

        const complete = this.isSetupComplete();
        const ready = isConnected && complete;
        const checklist = document.getElementById('sg-setup-checklist');
        const msg = document.getElementById('sg-setup-msg');
        const generateBtn = document.getElementById('sg-generate-btn');

        if (checklist) {
            checklist.classList.toggle('safe', ready);
            checklist.classList.toggle('unsafe', !ready);
        }
        if (msg) {
            if (!isConnected) msg.textContent = 'Connect to the machine before setup.';
            else if (complete) msg.textContent = 'Setup complete. Generate the spoilboard grid when ready.';
            else if (nextStep === 'home') msg.innerHTML = 'Use <kbd class="inline-flex rounded border border-current px-1 font-mono text-[10px] leading-4">Home All</kbd>, then confirm once it is complete.';
            else msg.textContent = 'Please zero Z on the spoilboard, then confirm once it is complete.';
        }
        if (generateBtn) {
            generateBtn.disabled = !ready;
            generateBtn.classList.toggle('opacity-50', !ready);
            generateBtn.classList.toggle('cursor-not-allowed', !ready);
        }
    }
}
