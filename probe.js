export class ProbeHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        // State Machine
        this.activeRoutine = null;
        this.routineStep = 0;
        this.probeData = [];
        this.tempData = {};

        // Selected Corners (UI State, not persisted in store usually, but could be)
        this.selections = {
            outsideCorner: 'FL',
            insideCorner: 'FL'
        };

        this.initUI();
    }

    initUI() {
        // Render initial values from Store
        this.renderSettings();
    }

    // Sync UI inputs to Store
    saveSettings() {
        const s = this.store.data.probe; // Shorthand

        // Inputs
        if(document.getElementById('prb-tool')) this.store.set('probe.toolDiameter', parseFloat(document.getElementById('prb-tool').value) || 0);
        if(document.getElementById('prb-z-thick')) this.store.set('probe.plateThickness', parseFloat(document.getElementById('prb-z-thick').value) || 0);
        if(document.getElementById('prb-xy-offset')) this.store.set('probe.xyPlateOffset', parseFloat(document.getElementById('prb-xy-offset').value) || 0);

        if(document.getElementById('prb-feed')) this.store.set('probe.feed', parseFloat(document.getElementById('prb-feed').value) || 100);
        if(document.getElementById('prb-feed-latch')) this.store.set('probe.feedLatch', parseFloat(document.getElementById('prb-feed-latch').value) || 25);
        if(document.getElementById('prb-dist')) this.store.set('probe.travel', parseFloat(document.getElementById('prb-dist').value) || 25);
        if(document.getElementById('prb-retract')) this.store.set('probe.retract', parseFloat(document.getElementById('prb-retract').value) || 2);
        if(document.getElementById('prb-edge-dist')) this.store.set('probe.clearance', parseFloat(document.getElementById('prb-edge-dist').value) || 5);
        if(document.getElementById('prb-z-depth')) this.store.set('probe.zDepth', parseFloat(document.getElementById('prb-z-depth').value) || 5);

        if(document.getElementById('prb-boss-x')) this.store.set('probe.bossW', parseFloat(document.getElementById('prb-boss-x').value) || 0);
        if(document.getElementById('prb-boss-y')) this.store.set('probe.bossH', parseFloat(document.getElementById('prb-boss-y').value) || 0);

        // Main Toggle
        const toggle = document.getElementById('prb-use-plate-main');
        if(toggle) {
            this.store.set('probe.usePlate', toggle.checked);
        }

        this.renderSettings(); // Re-render to update text statuses
    }

    renderSettings() {
        const s = this.store.data.probe;

        if(document.getElementById('prb-tool')) document.getElementById('prb-tool').value = s.toolDiameter;
        if(document.getElementById('prb-z-thick')) document.getElementById('prb-z-thick').value = s.plateThickness;
        if(document.getElementById('prb-xy-offset')) document.getElementById('prb-xy-offset').value = s.xyPlateOffset;

        if(document.getElementById('prb-feed')) document.getElementById('prb-feed').value = s.feed;
        if(document.getElementById('prb-feed-latch')) document.getElementById('prb-feed-latch').value = s.feedLatch;
        if(document.getElementById('prb-dist')) document.getElementById('prb-dist').value = s.travel;
        if(document.getElementById('prb-retract')) document.getElementById('prb-retract').value = s.retract;
        if(document.getElementById('prb-edge-dist')) document.getElementById('prb-edge-dist').value = s.clearance;
        if(document.getElementById('prb-z-depth')) document.getElementById('prb-z-depth').value = s.zDepth;

        if(document.getElementById('prb-boss-x')) document.getElementById('prb-boss-x').value = s.bossW;
        if(document.getElementById('prb-boss-y')) document.getElementById('prb-boss-y').value = s.bossH;

        // Sync Main Toggle
        const toggle = document.getElementById('prb-use-plate-main');
        if(toggle) toggle.checked = s.usePlate;

        // Update Text Status on cards
        const statusEls = document.querySelectorAll('.plate-status-text');
        statusEls.forEach(el => {
            if(s.usePlate) {
                el.textContent = "Mode: Plate";
                el.classList.replace('text-grey', 'text-primary-dark');
                el.classList.add('font-bold');
            } else {
                el.textContent = "Mode: Stock (No Plate)";
                el.classList.replace('text-primary-dark', 'text-grey');
                el.classList.remove('font-bold');
            }
        });
    }

    selectCorner(btn, type, corner) {
        if(type === 'Outside') this.selections.outsideCorner = corner;
        else this.selections.insideCorner = corner;

        const parent = btn.parentElement;
        const selectedClasses = ['bg-primary', 'border-2', 'border-black/20', 'ring-2', 'ring-primary/30'];
        const outsideUnselected = ['bg-grey-bg', 'border', 'border-grey-light'];
        const insideUnselected = ['bg-white', 'shadow-inner'];

        parent.querySelectorAll('button').forEach(b => {
            b.classList.remove(...selectedClasses);
            if(type === 'Inside') {
                b.classList.add(...insideUnselected);
                b.classList.remove(...outsideUnselected);
            } else {
                b.classList.add(...outsideUnselected);
                b.classList.remove(...insideUnselected);
            }
        });

        if(type === 'Inside') btn.classList.remove(...insideUnselected);
        else btn.classList.remove(...outsideUnselected);

        btn.classList.add(...selectedClasses);
    }

    handleProbeResult(line) {
        if (!this.activeRoutine) return;

        // Parse: [PRB:0.000,0.000,0.000:1]
        const content = line.substring(5, line.length - 1);
        const parts = content.split(':');
        const coords = parts[0].split(',').map(Number); // [X, Y, Z]
        const success = parts[1] === '1';

        if (!success) {
            this.term.writeln('\x1b[31mProbe Failed: No Contact. Aborting.\x1b[0m');
            this.activeRoutine = null;
            return;
        }

        this.routineStep++;

        if (this.activeRoutine === 'OUTSIDE_CORNER') this.stepOutsideCorner(coords);
        else if (this.activeRoutine === 'POCKET') this.stepPocket(coords);
        else if (this.activeRoutine === 'BOSS') this.stepBoss(coords);
    }

    // ==========================================
    // 1. Z PROBE
    // ==========================================
    runZProbe() {
        this.saveSettings();
        const s = this.store.data.probe;
        this.term.writeln(`\x1b[34m> Starting Z-Probe (Plate: ${s.usePlate})...\x1b[0m`);

        const zSet = s.usePlate ? s.plateThickness : 0;

        this.sendBatch([
            'G91',
            `G38.2 Z-${s.travel} F${s.feed}`,
            `G10 L20 P0 Z${zSet.toFixed(3)}`,
            `G0 Z${s.retract}`,
            'G90'
        ]);
    }

    // ==========================================
    // 2. SINGLE AXIS
    // ==========================================
    runSingleAxis(axis, dir) {
        this.saveSettings();
        const s = this.store.data.probe;
        const rad = s.toolDiameter / 2;

        const plateOffset = s.usePlate ? s.xyPlateOffset : 0;
        const totalOffset = rad + plateOffset;

        const setVal = -(dir * totalOffset);

        this.term.writeln(`\x1b[34m> Probing ${axis}... (Plate: ${s.usePlate})\x1b[0m`);
        this.sendBatch([
            'G91',
            `G38.2 ${axis}${dir * s.travel} F${s.feed}`,
            `G10 L20 P0 ${axis}${setVal.toFixed(3)}`,
            `G0 ${axis}${-(dir * s.retract)}`,
            'G90'
        ]);
    }

    // ==========================================
    // 3. OUTSIDE CORNER
    // ==========================================
    runCornerProbe(type) {
        if(type === 'Inside') {
            alert("Inside corner probing logic not fully implemented in this demo.");
            return;
        }

        this.saveSettings();
        const corner = this.selections.outsideCorner;
        const s = this.store.data.probe;

        let xDirMult = (corner.includes('R')) ? 1 : -1;
        let yDirMult = (corner.includes('B')) ? 1 : -1;

        this.tempData = { xDir: xDirMult, yDir: yDirMult };
        this.activeRoutine = 'OUTSIDE_CORNER';
        this.routineStep = 0;

        this.term.writeln(`\x1b[34m> Starting Outside Corner (${corner}). UsePlate: ${s.usePlate}\x1b[0m`);
        this.ws.sendCommand(`G91 G38.2 Z-${s.travel} F${s.feed}`);
    }

    stepOutsideCorner(coords) {
        const s = this.store.data.probe;
        const rad = s.toolDiameter / 2;
        const xDir = this.tempData.xDir;
        const yDir = this.tempData.yDir;

        const plateOffset = s.usePlate ? s.xyPlateOffset : 0;
        const moveDist = s.clearance + rad + plateOffset + 2;

        if (this.routineStep === 1) {
            // Z Probed
            const zSet = s.usePlate ? s.plateThickness : 0;
            this.ws.sendCommand(`G10 L20 P0 Z${zSet}`);
            this.ws.sendCommand(`G0 Z${s.retract}`);

            this.ws.sendCommand(`G0 X${(xDir * moveDist).toFixed(3)}`);
            this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);

            setTimeout(() => {
                this.ws.sendCommand(`G38.2 X${(-xDir * (s.travel)).toFixed(3)} F${s.feed}`);
            }, 200);
        }
        else if (this.routineStep === 2) {
            // X Probed
            const probeDir = -xDir;
            const totalOffset = rad + plateOffset;
            const xSet = -(probeDir * totalOffset);
            this.ws.sendCommand(`G10 L20 P0 X${xSet.toFixed(3)}`);

            this.ws.sendCommand(`G0 X${(xDir * s.retract).toFixed(3)}`);
            this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
            this.ws.sendCommand(`G90 G0 X0`);
            this.ws.sendCommand(`G91`);

            this.ws.sendCommand(`G0 Y${(yDir * moveDist).toFixed(3)}`);
            this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);

            setTimeout(() => {
                this.ws.sendCommand(`G38.2 Y${(-yDir * s.travel).toFixed(3)} F${s.feed}`);
            }, 200);
        }
        else if (this.routineStep === 3) {
            // Y Probed
            const probeDir = -yDir;
            const totalOffset = rad + plateOffset;
            const ySet = -(probeDir * totalOffset);
            this.ws.sendCommand(`G10 L20 P0 Y${ySet.toFixed(3)}`);

            this.ws.sendCommand(`G0 Y${(yDir * s.retract).toFixed(3)}`);
            this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
            this.ws.sendCommand(`G90 G0 X0 Y0`);

            this.term.writeln(`\x1b[32m> Corner Probe Complete.\x1b[0m`);
            this.activeRoutine = null;
        }
    }

    // ==========================================
    // 4. POCKET
    // ==========================================
    runPocketCenter() {
        this.saveSettings();
        const s = this.store.data.probe;
        this.activeRoutine = 'POCKET';
        this.routineStep = 0;
        this.probeData = [];
        this.term.writeln(`\x1b[34m> Starting Pocket Center...\x1b[0m`);
        this.ws.sendCommand(`G91 G38.2 X${s.travel} F${s.feed}`);
    }

    stepPocket(coords) {
        const s = this.store.data.probe;
        if (this.routineStep === 1) {
            this.probeData.push(coords[0]); // x1
            this.ws.sendCommand(`G0 X-${s.retract}`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 X-${s.travel * 2} F${s.feed}`); }, 200);
        }
        else if (this.routineStep === 2) {
            this.probeData.push(coords[0]); // x2
            const centerX = (this.probeData[0] + this.probeData[1]) / 2;
            this.ws.sendCommand(`G90 G0 X${centerX.toFixed(3)}`);
            this.ws.sendCommand(`G91`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 Y${s.travel} F${s.feed}`); }, 500);
        }
        else if (this.routineStep === 3) {
            this.probeData.push(coords[1]); // y1
            this.ws.sendCommand(`G0 Y-${s.retract}`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 Y-${s.travel * 2} F${s.feed}`); }, 200);
        }
        else if (this.routineStep === 4) {
            this.probeData.push(coords[1]); // y2
            const centerY = (this.probeData[2] + this.probeData[3]) / 2;
            this.ws.sendCommand(`G90 G0 Y${centerY.toFixed(3)}`);
            this.ws.sendCommand(`G10 L20 P0 X0 Y0`);
            this.term.writeln(`\x1b[32m> Pocket Center Found.\x1b[0m`);
            this.activeRoutine = null;
        }
    }

    // ==========================================
    // 5. BOSS
    // ==========================================
    runBossCenter(type) {
        this.saveSettings();
        const s = this.store.data.probe;
        if (s.bossW <= 0 || s.bossH <= 0) {
            alert("Please enter approximate Boss/Stock dimensions in Settings first.");
            return;
        }
        this.activeRoutine = 'BOSS';
        this.routineStep = 0;
        this.probeData = [];
        this.tempData = { type: type };
        this.term.writeln(`\x1b[34m> Starting Boss Center...\x1b[0m`);
        const safeRad = (s.toolDiameter/2) + 2;
        const moveX = (s.bossW / 2) + s.clearance + safeRad;
        this.ws.sendCommand(`G91 G0 X${moveX.toFixed(3)}`);
        this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);
        setTimeout(() => { this.ws.sendCommand(`G38.2 X-20 F${s.feed}`); }, 500);
    }

    stepBoss(coords) {
        const s = this.store.data.probe;
        const safeRad = (s.toolDiameter/2) + 2;

        if (this.routineStep === 1) {
            this.probeData.push(coords[0]);
            this.ws.sendCommand(`G0 X${s.retract}`);
            this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
            const totalWidth = s.bossW + (s.clearance*2) + (safeRad*2);
            this.ws.sendCommand(`G0 X-${totalWidth.toFixed(3)}`);
            this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 X20 F${s.feed}`); }, 500);
        }
        else if (this.routineStep === 2) {
            this.probeData.push(coords[0]);
            const centerX = (this.probeData[0] + this.probeData[1]) / 2;
            this.ws.sendCommand(`G0 X-${s.retract}`);
            this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
            this.ws.sendCommand(`G90 G0 X${centerX.toFixed(3)}`);
            this.ws.sendCommand(`G91`);
            const moveY = (s.bossH / 2) + s.clearance + safeRad;
            this.ws.sendCommand(`G0 Y${moveY.toFixed(3)}`);
            this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 Y-20 F${s.feed}`); }, 500);
        }
        else if (this.routineStep === 3) {
            this.probeData.push(coords[1]);
            this.ws.sendCommand(`G0 Y${s.retract}`);
            this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
            const totalHeight = s.bossH + (s.clearance*2) + (safeRad*2);
            this.ws.sendCommand(`G0 Y-${totalHeight.toFixed(3)}`);
            this.ws.sendCommand(`G0 Z-${(s.retract + s.zDepth).toFixed(3)}`);
            setTimeout(() => { this.ws.sendCommand(`G38.2 Y20 F${s.feed}`); }, 500);
        }
        else if (this.routineStep === 4) {
             this.probeData.push(coords[1]);
             const centerY = (this.probeData[2] + this.probeData[3]) / 2;
             this.ws.sendCommand(`G0 Y-${s.retract}`);
             this.ws.sendCommand(`G0 Z${(s.retract + s.zDepth).toFixed(3)}`);
             this.ws.sendCommand(`G90 G0 Y${centerY.toFixed(3)}`);
             this.ws.sendCommand(`G10 L20 P0 X0 Y0`);
             this.term.writeln(`\x1b[32m> Boss Center Found.\x1b[0m`);
             this.activeRoutine = null;
        }
    }

    sendBatch(cmds) {
        cmds.forEach(c => this.ws.sendCommand(c));
    }
}
