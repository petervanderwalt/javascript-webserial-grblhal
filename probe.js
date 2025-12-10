export class ProbeHandler {
    constructor(ws, term) {
        this.ws = ws;
        this.term = term;

        // Default Settings
        this.settings = {
            toolDiameter: 6.35,
            xPlateOffset: 10,   // Wall thickness X
            yPlateOffset: 10,   // Wall thickness Y
            edgeClearance: 20,  // NEW: Distance to move out to clear plate
            zProbeDepth: 10,    // NEW: Distance to drop Z for side probing
            probeFeed: 100,
            latchFeed: 25,
            retractDist: 2,
            maxTravel: 25,
            plateThickness: 15,
            useG38_1: false
        };

        this.activeRoutine = null;
        this.routineStep = 0;
        this.probeData = [];

        this.loadSettings();
    }

    loadSettings() {
        const s = localStorage.getItem('grbl_probe_settings');
        if (s) {
            this.settings = { ...this.settings, ...JSON.parse(s) };
        }
        this.renderSettings();
    }

    saveSettings() {
        this.settings.toolDiameter = parseFloat(document.getElementById('prb-tool').value) || 6.35;
        this.settings.xPlateOffset = parseFloat(document.getElementById('prb-x-offset').value) || 10;
        this.settings.yPlateOffset = parseFloat(document.getElementById('prb-y-offset').value) || 10;
        this.settings.edgeClearance = parseFloat(document.getElementById('prb-edge-dist').value) || 20;
        this.settings.zProbeDepth = parseFloat(document.getElementById('prb-z-depth').value) || 10;
        this.settings.probeFeed = parseFloat(document.getElementById('prb-feed').value) || 100;
        this.settings.retractDist = parseFloat(document.getElementById('prb-retract').value) || 2;
        this.settings.maxTravel = parseFloat(document.getElementById('prb-dist').value) || 25;
        this.settings.plateThickness = parseFloat(document.getElementById('prb-z-thick').value) || 15;

        localStorage.setItem('grbl_probe_settings', JSON.stringify(this.settings));
        this.term.writeln('\x1b[32m> Probe settings saved.\x1b[0m');
    }

    renderSettings() {
        const ids = {
            'prb-tool': this.settings.toolDiameter,
            'prb-x-offset': this.settings.xPlateOffset,
            'prb-y-offset': this.settings.yPlateOffset,
            'prb-edge-dist': this.settings.edgeClearance,
            'prb-z-depth': this.settings.zProbeDepth,
            'prb-feed': this.settings.probeFeed,
            'prb-retract': this.settings.retractDist,
            'prb-dist': this.settings.maxTravel,
            'prb-z-thick': this.settings.plateThickness
        };
        for (const [id, val] of Object.entries(ids)) {
            const el = document.getElementById(id);
            if (el) el.value = val;
        }
    }

    handleProbeResult(line) {
        if (!this.activeRoutine) return;

        const content = line.substring(5, line.length - 1);
        const parts = content.split(':');
        const coords = parts[0].split(',').map(Number);
        const success = parts[1] === '1';

        if (!success && !this.settings.useG38_1) {
            this.term.writeln('\x1b[31mProbe Failed: No Contact\x1b[0m');
            this.activeRoutine = null;
            return;
        }

        this.nextRoutineStep(coords);
    }

    // --- Routines ---

    /**
     * Fully Automatic XYZ Corner Probe (Front-Left)
     * Sequence: Z -> X -> Y
     */
    runXYZCorner() {
        this.saveSettings();
        this.activeRoutine = 'XYZ_CORNER';
        this.routineStep = 0;

        const s = this.settings;
        const code = this.settings.useG38_1 ? 'G38.1' : 'G38.2';

        this.term.writeln(`\x1b[34m> Starting Automatic XYZ Corner Probe...\x1b[0m`);

        // Step 1: Probe Z (Top of Plate)
        this.ws.sendCommand(`G91 ${code} Z-${s.maxTravel} F${s.probeFeed}`);
    }

    nextRoutineStep(coords) {
        if (!this.activeRoutine) return;

        const s = this.settings;
        const code = this.settings.useG38_1 ? 'G38.1' : 'G38.2';
        const radius = s.toolDiameter / 2;

        // --- XYZ CORNER ROUTINE ---
        if (this.activeRoutine === 'XYZ_CORNER') {

            // Step 0: Finished Z Probe
            if (this.routineStep === 0) {
                this.term.writeln(`\x1b[32m> Z Probed. Moving to X...\x1b[0m`);

                // 1. Set Z Zero (Plate Thickness)
                this.ws.sendCommand(`G10 L20 P0 Z${s.plateThickness}`);

                // 2. Retract Z
                this.ws.sendCommand(`G0 Z${s.retractDist}`);

                // 3. Move X- to clear plate
                // Distance = X_Offset + ToolRadius + EdgeClearance
                const moveLeft = s.xPlateOffset + radius + s.edgeClearance;
                this.ws.sendCommand(`G0 X-${moveLeft.toFixed(3)}`);

                // 4. Drop Z for Side Probe
                // Drop = Retract + Z_Probe_Depth (usually go 10mm below top)
                const dropZ = s.retractDist + s.zProbeDepth;
                this.ws.sendCommand(`G0 Z-${dropZ.toFixed(3)}`);

                // 5. Probe X+ (Right)
                // Travel = EdgeClearance + 10mm buffer
                setTimeout(() => {
                    this.routineStep = 1;
                    this.ws.sendCommand(`${code} X${(s.edgeClearance + 10).toFixed(3)} F${s.probeFeed}`);
                }, 500);
            }

            // Step 1: Finished X Probe
            else if (this.routineStep === 1) {
                this.term.writeln(`\x1b[32m> X Probed. Moving to Y...\x1b[0m`);

                // 1. Set X Zero
                // X Pos = -(ToolRadius + XOffset)
                const xSet = -(radius + s.xPlateOffset);
                this.ws.sendCommand(`G10 L20 P0 X${xSet.toFixed(3)}`);

                // 2. Retract X-
                this.ws.sendCommand(`G0 X-2`);

                // 3. Raise Z to Safe Height
                const raiseZ = s.retractDist + s.zProbeDepth;
                this.ws.sendCommand(`G0 Z${raiseZ.toFixed(3)}`);

                // 4. Return X to "Start" (approx above corner)
                // We moved Left by (Offset+Radius+Clearance) then Probed Right by (Clearance - 2ish?)
                // Safest: Move to X0 (which is now defined relative to stock corner)
                // Then move X- (Left) by (Radius + Offset + Clearance) again?
                // Or just move Y from here?
                // Standard: Go back to approx start X to avoid hitting clamps if we move Y now.
                // We just set X, so G90 X0 moves to offset edge. X-20 moves left.
                // Let's go to X coordinate corresponding to "Above Plate":
                // Plate center is roughly at X = (PlateWidth/2 - WallThick).
                // Let's just return to X0 (Machine Corner) + offset?
                // Actually, let's just reverse the initial moveLeft?
                // Simpler: Move X back to 0 (relative to stock) + clearance?
                // Let's move to X = -(Radius + Offset + Clearance). ie. Back to the "Clear" point.

                // Actually, standard logic:
                // Lift Z.
                // Move X back to start point (move Right).
                // Move Y- to clear point.

                const returnRight = s.xPlateOffset + radius + s.edgeClearance;
                // But we are currently at X contact point.
                // Let's just move to X = 0 (relative) then X- (clearance) logic is hard blindly.
                // EASIEST: Just use G90 for positioning since we just Set X.

                this.ws.sendCommand(`G90 G0 X0`); // Go to corner X
                this.ws.sendCommand(`G91`); // Back to rel

                // 5. Move Y- (Front)
                const moveFront = s.yPlateOffset + radius + s.edgeClearance;
                this.ws.sendCommand(`G0 Y-${moveFront.toFixed(3)}`);

                // 6. Drop Z
                this.ws.sendCommand(`G0 Z-${raiseZ.toFixed(3)}`); // Drop back down

                // 7. Probe Y+ (Back)
                setTimeout(() => {
                    this.routineStep = 2;
                    this.ws.sendCommand(`${code} Y${(s.edgeClearance + 10).toFixed(3)} F${s.probeFeed}`);
                }, 500);
            }

            // Step 2: Finished Y Probe
            else if (this.routineStep === 2) {
                this.term.writeln(`\x1b[32m> Y Probed. Cycle Complete.\x1b[0m`);

                // 1. Set Y Zero
                const ySet = -(radius + s.yPlateOffset);
                this.ws.sendCommand(`G10 L20 P0 Y${ySet.toFixed(3)}`);

                // 2. Retract Y-
                this.ws.sendCommand(`G0 Y-2`);

                // 3. Raise Z
                const raiseZ = s.retractDist + s.zProbeDepth;
                this.ws.sendCommand(`G0 Z${raiseZ.toFixed(3)}`);

                // 4. Move to X0 Y0 (The Corner)
                this.ws.sendCommand(`G90 G0 X0 Y0`);

                this.activeRoutine = null;
            }
        }

        // --- CENTER FINDING ROUTINE ---
        else if (this.activeRoutine.startsWith('CENTER_')) {
            const axisIdx = this.activeRoutine.endsWith('X') ? 0 : 1;
            const axisChar = this.activeRoutine.endsWith('X') ? 'X' : 'Y';
            const currentPos = coords[axisIdx];

            if (this.routineStep === 1) {
                this.probeData.push(currentPos);
                this.routineStep = 2;
                this.ws.sendCommand(`G0 ${axisChar}-${s.retractDist}`);
                setTimeout(() => {
                    this.ws.sendCommand(`${code} ${axisChar}-${s.maxTravel * 2.5} F${s.probeFeed}`);
                }, 200);

            } else if (this.routineStep === 2) {
                this.probeData.push(currentPos);
                const center = (this.probeData[0] + this.probeData[1]) / 2;
                this.term.writeln(`\x1b[35m> Center Found: ${center.toFixed(3)}\x1b[0m`);
                this.ws.sendCommand(`G91 G0 ${axisChar}${s.retractDist}`);
                setTimeout(() => {
                    this.ws.sendCommand(`G53 G90 G0 ${axisChar}${center.toFixed(3)}`);
                    this.ws.sendCommand(`G10 L20 P0 ${axisChar}0`);
                    this.activeRoutine = null;
                }, 500);
            }
        }
    }

    // --- Simple Primitives ---

    runZProbe() {
        this.saveSettings();
        const s = this.settings;
        const code = this.settings.useG38_1 ? 'G38.1' : 'G38.2';
        this.sendBatch([
            `G91`,
            `${code} Z-${s.maxTravel} F${s.probeFeed}`,
            `G10 L20 P0 Z${s.plateThickness}`,
            `G0 Z${s.retractDist}`,
            `G90`
        ]);
    }

    runSingleAxis(axis, dir) {
        this.saveSettings();
        const s = this.settings;
        const radius = s.toolDiameter / 2;
        const code = this.settings.useG38_1 ? 'G38.1' : 'G38.2';
        const dist = dir * s.maxTravel;
        const plateOffset = (axis.toUpperCase() === 'X') ? s.xPlateOffset : s.yPlateOffset;
        const totalOffset = radius + plateOffset;
        const coordSetting = -(dir * totalOffset);

        this.sendBatch([
            `G91`,
            `${code} ${axis}${dist} F${s.probeFeed}`,
            `G10 L20 P0 ${axis}${coordSetting.toFixed(3)}`,
            `G0 ${axis}${-(dir * s.retractDist)}`,
            `G90`
        ]);
    }

    runCenterFind(axis) {
        this.saveSettings();
        this.activeRoutine = 'CENTER_' + axis;
        this.routineStep = 1;
        this.probeData = [];
        this.term.writeln(`\x1b[34m> Starting ${axis} Center Find...\x1b[0m`);
        this.ws.sendCommand(`G91 ${this.settings.useG38_1?'G38.1':'G38.2'} ${axis}${this.settings.maxTravel} F${this.settings.probeFeed}`);
    }

    sendBatch(cmds) {
        cmds.forEach(c => this.ws.sendCommand(c));
    }
}
