export class SurfacingHandler {
    constructor(viewer, sdHandler, term, store) {
        this.viewer = viewer;
        this.sdHandler = sdHandler;
        this.term = term;
        this.store = store;
        this.spoilboardSetup = {
            home: false,
            z: false
        };
        this.pendingHomeAll = false;
        this.pendingHomeAllMotion = false;
        this.pendingZProbe = false;
        this.pendingZProbeMotion = false;
        window.addEventListener('machine-state-changed', (e) => this.handleSetupMachineState(e.detail?.state || ''));
        window.addEventListener('machine-connection-changed', (e) => this.handleSetupConnectionState(!!e.detail?.connected));

        // Ensure store values match current global units before UI render
        this.syncStoreUnits();

        // Initialize local unit state from Global Config
        this.units = this.store.get('general.units') || 'mm';

        this.initUI();
    }

    // New method: Convert stored numbers if the unit system changed while app was closed
    syncStoreUnits() {
        const globalUnits = this.store.get('general.units') || 'mm';
        const storedUnits = this.store.get('surfacing.units') || 'mm'; // Default to mm if missing

        if (storedUnits !== globalUnits) {
            console.log(`[Surfacing] converting stored values from ${storedUnits} to ${globalUnits}`);
            const toMM = (globalUnits === 'mm');
            const factor = toMM ? 25.4 : (1 / 25.4);
            const precision = toMM ? 2 : 4;

            const s = this.store.data.surfacing;

            // Convert dimensional fields
            const fields = ['toolDiameter', 'feed', 'width', 'height', 'depthPerPass', 'finalDepth', 'clearance'];

            fields.forEach(key => {
                if (typeof s[key] === 'number') {
                    s[key] = Number((s[key] * factor).toFixed(precision));
                }
            });

            // Update stored unit tag
            s.units = globalUnits;
            this.store.save();
        }
    }

    initUI() {
        this.renderSettings();

        // Bind Inputs to Store on change
        const inputs = document.querySelectorAll('#tab-tool-surfacing input, #tab-tool-surfacing select');
        inputs.forEach(input => {
            input.addEventListener('change', () => this.saveSettings());
        });

        // Listen for Unit Changes from global event
        window.addEventListener('viewer-units-changed', (e) => {
            if (e.detail && e.detail.units) {
                this.setUnits(e.detail.units);
            }
        });
    }

    setUnits(newUnits) {
        if (this.units === newUnits) return;

        // Determine conversion factor
        // If switching TO mm: inches * 25.4
        // If switching TO inch: mm / 25.4
        const toMM = (newUnits === 'mm');
        const factor = toMM ? 25.4 : (1 / 25.4);
        const precision = toMM ? 2 : 4; // 2 decimals for mm, 4 for inches

        // Fields that represent linear dimensions/speeds
        const fields = [
            'surf-tool',
            'surf-feed',
            'surf-x',
            'surf-y',
            'surf-z-step',
            'surf-z-final',
            'surf-z-safe'
        ];

        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const currentVal = parseFloat(el.value) || 0;
                const newVal = currentVal * factor;
                el.value = Number(newVal.toFixed(precision)); // Remove trailing zeros
            }
        });

        // Update Labels (Search and Replace text in labels)
        const labels = document.querySelectorAll('#tab-tool-surfacing label');
        labels.forEach(lbl => {
            if (toMM) {
                lbl.innerHTML = lbl.innerHTML.replace('(in)', '(mm)');
                lbl.innerHTML = lbl.innerHTML.replace('(in/min)', '(mm/min)');
            } else {
                lbl.innerHTML = lbl.innerHTML.replace('(mm)', '(in)');
                lbl.innerHTML = lbl.innerHTML.replace('(mm/min)', '(in/min)');
            }
        });

        this.units = newUnits;
        this.saveSettings(); // Persist converted values to store
    }

    saveSettings() {
        // Helper to get value securely
        const val = (id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            if (el.type === 'checkbox') return el.checked;
            // Return string for direction, float for numbers
            if (id === 'surf-dir') return el.value;
            return parseFloat(el.value) || 0;
        };

        this.store.set('surfacing.toolDiameter', val('surf-tool'));
        this.store.set('surfacing.stepover', val('surf-stepover'));
        this.store.set('surfacing.feed', val('surf-feed'));
        this.store.set('surfacing.rpm', val('surf-rpm'));

        this.store.set('surfacing.width', val('surf-x'));
        this.store.set('surfacing.height', val('surf-y'));
        this.store.set('surfacing.direction', val('surf-dir'));

        this.store.set('surfacing.depthPerPass', val('surf-z-step'));
        this.store.set('surfacing.finalDepth', val('surf-z-final'));
        this.store.set('surfacing.clearance', val('surf-z-safe'));

        this.store.set('surfacing.useCoolant', val('surf-coolant'));
        this.store.set('surfacing.useFraming', val('surf-framing'));
        this.store.set('surfacing.useMaxArea', val('surf-dim-toggle'));

        // Save the current units context
        this.store.set('surfacing.units', this.units);
    }

    renderSettings() {
        const s = this.store.data.surfacing;

        // Apply Unit Labels based on store state (or just current state)
        // Since we synced in constructor, s.units should match this.units.
        // But we need to ensure labels match what's in the input boxes.
        const isMM = (this.units === 'mm');
        const labels = document.querySelectorAll('#tab-tool-surfacing label');
        labels.forEach(lbl => {
            // Reset to base state then apply
            const hasMM = lbl.innerHTML.includes('(mm)');
            const hasIN = lbl.innerHTML.includes('(in)');

            if (isMM && hasIN) {
                lbl.innerHTML = lbl.innerHTML.replace('(in)', '(mm)').replace('(in/min)', '(mm/min)');
            } else if (!isMM && hasMM) {
                lbl.innerHTML = lbl.innerHTML.replace('(mm)', '(in)').replace('(mm/min)', '(in/min)');
            }
        });

        const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = v;
            else el.value = v;
        };

        setVal('surf-tool', s.toolDiameter);
        setVal('surf-stepover', s.stepover);
        setVal('surf-feed', s.feed);
        setVal('surf-rpm', s.rpm);

        setVal('surf-x', s.width);
        setVal('surf-y', s.height);
        setVal('surf-dir', s.direction);

        setVal('surf-z-step', s.depthPerPass);
        setVal('surf-z-final', s.finalDepth);
        setVal('surf-z-safe', s.clearance);

        setVal('surf-coolant', s.useCoolant);
        setVal('surf-framing', s.useFraming);
        setVal('surf-dim-toggle', s.useMaxArea);

        this._renderSpoilboardDimensions();
        this._updateDimModeUI(!!s.useMaxArea);
        this.updateSpoilboardSetupUI();
    }

    _updateDimModeUI(useMaxArea) {
        const dimFields = document.getElementById('surf-dim-fields');
        const customInfo = document.getElementById('surf-dim-custom-info');
        const customSetup = document.getElementById('surf-setup-custom');
        const spoilboardSetup = document.getElementById('surf-setup-spoilboard');
        const customSetupTitle = document.getElementById('surf-setup-custom-title');
        const spoilboardSetupTitle = document.getElementById('surf-setup-spoilboard-title');
        const spoilboardDims = document.getElementById('surf-dim-spoilboard');
        if (dimFields) {
            dimFields.style.maxHeight = useMaxArea ? '0px' : '500px';
            dimFields.style.opacity = useMaxArea ? '0' : '1';
            dimFields.classList.toggle('hidden', useMaxArea);
        }
        if (customInfo) {
            customInfo.classList.toggle('hidden', useMaxArea);
        }
        if (customSetup) {
            customSetup.classList.toggle('hidden', useMaxArea);
        }
        if (customSetupTitle) {
            customSetupTitle.classList.toggle('hidden', useMaxArea);
        }
        if (spoilboardSetup) {
            spoilboardSetup.classList.toggle('hidden', !useMaxArea);
        }
        if (spoilboardSetupTitle) {
            spoilboardSetupTitle.classList.toggle('hidden', !useMaxArea);
        }
        if (spoilboardDims) {
            spoilboardDims.style.maxHeight = useMaxArea ? '500px' : '0px';
            spoilboardDims.style.opacity = useMaxArea ? '1' : '0';
            spoilboardDims.classList.toggle('hidden', !useMaxArea);
        }
        this.updateSpoilboardSetupUI();
    }

    _renderSpoilboardDimensions() {
        const s = this.store.data.surfacing;
        const unit = this.units === 'mm' ? 'mm' : 'in';
        const xEl = document.getElementById('surf-dim-spoilboard-x');
        const yEl = document.getElementById('surf-dim-spoilboard-y');
        if (xEl) xEl.textContent = `${Number(s.width || 0).toFixed(this.units === 'mm' ? 2 : 4)} ${unit}`;
        if (yEl) yEl.textContent = `${Number(s.height || 0).toFixed(this.units === 'mm' ? 2 : 4)} ${unit}`;
    }

    generateGCode() {
        if (document.getElementById('surf-dim-toggle') && document.getElementById('surf-dim-toggle').checked) {
            this.autoSpoilboard(); // Silent calculation before gen
        }
        
        this.saveSettings();
        const s = this.store.data.surfacing;

        // --- VALIDATION ---
        const minDim = this.units === 'mm' ? 0.1 : 0.004;
        if (s.toolDiameter <= minDim) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Tool Diameter', `Tool Diameter must be greater than ${minDim}`);
            }
            return null;
        }
        if (s.stepover <= 1) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Stepover', 'Stepover must be greater than 1%');
            }
            return null;
        }
        if (s.depthPerPass <= 0) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Depth', 'Depth per pass must be greater than 0');
            }
            return null;
        }
        if (s.width <= s.toolDiameter || s.height <= s.toolDiameter) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Dimensions', 'Dimensions must be greater than Tool Diameter');
            }
            return null;
        }
        if (s.finalDepth <= 0) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Final Depth', 'Final Depth must be greater than 0');
            }
            return null;
        }

        let gcode = [];
        const comment = (msg) => gcode.push(`; ${msg}`);
        const cmd = (c) => gcode.push(c);
        const unitLabel = this.units === 'mm' ? 'mm' : 'in';

        // --- Header ---
        const d = new Date();
        comment(`Surfacing Job Generated: ${d.toLocaleTimeString()}`);
        comment(`Area: ${s.width}x${s.height}${unitLabel}, Depth: ${s.finalDepth}${unitLabel}`);
        comment(`Tool: ${s.toolDiameter}${unitLabel}, Stepover: ${s.stepover}%`);
        comment(`Direction: ${s.direction === 'X' ? 'Along X' : 'Along Y'}`);
        comment(`Units: ${this.units.toUpperCase()}`);

        // Set G21 (mm) or G20 (inch) based on current state
        const unitCmd = this.units === 'mm' ? 'G21' : 'G20';
        cmd(`${unitCmd} G90 G17`);
        cmd('G54');
        if (s.useMaxArea) {
            const xyZeroCommand = this.getSpoilboardXYZeroCommand(s.width, s.height, 1);
            if (xyZeroCommand) cmd(xyZeroCommand);
        }

        if (s.rpm > 0) cmd(`M3 S${s.rpm}`);
        if (s.useCoolant) cmd('M8');

        // Fmt helper for coordinate precision
        const fmt = (n) => n.toFixed(this.units === 'mm' ? 3 : 4);

        cmd(`G0 Z${fmt(s.clearance)}`);
        if (s.useMaxArea) {
            comment('X/Y work zero must be set to the machine front-left before running');
        }

        // --- Calculations ---
        const stepoverVal = s.toolDiameter * (s.stepover / 100.0);

        const isXDir = (s.direction === 'X');

        const radius = s.toolDiameter / 2.0;

        // STRICT BOUNDS (No Overshoot toolpath generation)
        const minMain = radius;
        const maxMain = (isXDir ? s.width : s.height) - radius;

        const minCross = radius;
        const maxCross = (isXDir ? s.height : s.width) - radius;

        // --- Z Passes Loop ---
        let currentZ = 0;
        const targetZ = -Math.abs(s.finalDepth);
        const zStep = Math.abs(s.depthPerPass);

        let zSafety = 0;

        while (true) {
            zSafety++;
            if (zSafety > 100) {
                const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
                if (reporter) {
                    reporter.showAlert('Safety Limit', 'Z-Pass safety limit reached. Check depth settings.');
                }
                break;
            }

            // Decrement Z
            currentZ -= zStep;

            // Clamp to target
            if (currentZ < targetZ) currentZ = targetZ;

            comment(`--- Pass Z: ${fmt(currentZ)} ---`);

            // 1. Move to Start (0,0)
            if (isXDir) cmd(`G0 X${fmt(minMain)} Y${fmt(minCross)}`);
            else cmd(`G0 X${fmt(minCross)} Y${fmt(minMain)}`);

            cmd(`G1 Z${fmt(currentZ)} F${s.feed / 2}`);

            // 2. Zig Zag Routine
            let posCross = minCross;
            let goingForward = true;
            let xySafety = 0;

            // Loop until cross position reaches the end dimension
            while (posCross <= maxCross + 0.0001) {
                xySafety++;
                if (xySafety > 10000) {
                    const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
                    if (reporter) {
                        reporter.showAlert('Safety Limit', 'XY Loop safety limit reached.');
                    }
                    break;
                }

                // Cut Main Axis
                const endMain = goingForward ? maxMain : minMain;
                if (isXDir) cmd(`G1 X${fmt(endMain)} F${s.feed}`);
                else cmd(`G1 Y${fmt(endMain)} F${s.feed}`);

                // Check done
                if (posCross >= maxCross - 0.0001) break;

                // Step Over
                posCross += stepoverVal;
                if (posCross > maxCross) posCross = maxCross; // Clamp last step

                // Move Cross Axis
                if (isXDir) cmd(`G1 Y${fmt(posCross)}`);
                else cmd(`G1 X${fmt(posCross)}`);

                goingForward = !goingForward;
            }

            // 3. Optional Framing Pass
            if (s.useFraming) {
                comment("Framing Pass");
                cmd(`G0 Z${fmt(s.clearance)}`);
                
                const frameMinX = isXDir ? minMain : minCross;
                const frameMinY = isXDir ? minCross : minMain;
                const frameMaxX = isXDir ? maxMain : maxCross;
                const frameMaxY = isXDir ? maxCross : maxMain;

                cmd(`G0 X${fmt(frameMinX)} Y${fmt(frameMinY)}`);
                cmd(`G1 Z${fmt(currentZ)} F${s.feed / 2}`);

                cmd(`G1 X${fmt(frameMaxX)} Y${fmt(frameMinY)} F${s.feed}`);
                cmd(`G1 X${fmt(frameMaxX)} Y${fmt(frameMaxY)}`);
                cmd(`G1 X${fmt(frameMinX)} Y${fmt(frameMaxY)}`);
                cmd(`G1 X${fmt(frameMinX)} Y${fmt(frameMinY)}`);
            }

            cmd(`G0 Z${fmt(s.clearance)}`);

            // Break if we just finished the final depth pass
            if (currentZ <= targetZ + 0.0001) break;
        }

        // --- Footer ---
        cmd('M5');
        if (s.useCoolant) cmd('M9');
        
        const endX = isXDir ? minMain : minCross;
        const endY = isXDir ? minCross : minMain;
        cmd(`G0 X${fmt(endX)} Y${fmt(endY)}`);
        
        cmd('M30');

        return gcode.join('\n');
    }

    loadToViewer() {
        if (document.getElementById('surf-dim-toggle')?.checked && !window.ws?.isConnected) {
            if (window.showToast) window.showToast('Connect before generating the spoilboard job', 'plug-zap', 'warning');
            return;
        }
        if (document.getElementById('surf-dim-toggle')?.checked && !this.isSpoilboardSetupComplete()) {
            if (window.showToast) window.showToast('Complete spoilboard setup first', 'list-checks', 'warning');
            return;
        }

        const gcode = this.generateGCode();
        if (gcode && window.viewer) {
            if (document.getElementById('surf-dim-toggle')?.checked) {
                const s = this.store.data.surfacing;
                const xyZeroCommand = this.getSpoilboardXYZeroCommand(s.width, s.height, 1);
                if (xyZeroCommand) window.sendCmd(xyZeroCommand);
            }
            const event = new CustomEvent('gcode-loaded', { detail: gcode });
            window.dispatchEvent(event);

            window.viewer.processGCodeString(gcode, 'Generated_Job.gcode parsed');

            document.querySelector("button[onclick*='viewer-view']").click();
            this.term.writeln("\x1b[32m> Surfacing Job Loaded to Viewer.\x1b[0m");
        }
    }

    markSpoilboardSetupStep(step) {
        if (!Object.prototype.hasOwnProperty.call(this.spoilboardSetup, step)) return;
        this.spoilboardSetup[step] = true;
        this.updateSpoilboardSetupUI();
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
            this.updateSpoilboardSetupUI();
            if (window.showToast) window.showToast('Setup action stopped by machine alarm', 'alert-triangle', 'error');
            return;
        }
        if (this.pendingHomeAll && this.pendingHomeAllMotion && s === 'idle') {
            this.pendingHomeAll = false;
            this.pendingHomeAllMotion = false;
            this.updateSpoilboardSetupUI();
        }
        if (this.pendingZProbe && s.startsWith('run')) {
            this.pendingZProbeMotion = true;
        }
        if (this.pendingZProbe && this.pendingZProbeMotion && s === 'idle') {
            this.pendingZProbe = false;
            this.pendingZProbeMotion = false;
            this.spoilboardSetup.z = true;
            this.updateSpoilboardSetupUI();
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
        this.updateSpoilboardSetupUI();
    }

    setSpoilboardZZero() {
        if (!window.ws || !window.ws.isConnected) {
            if (window.showToast) window.showToast('Connect before setting Z zero', 'plug-zap', 'warning');
            return;
        }

        this.spoilboardSetup.z = true;
        this.updateSpoilboardSetupUI();
        if (window.showToast) window.showToast('Z zero confirmed. Setup complete.', 'check-circle', 'success');
    }

    getSpoilboardXYZeroCommand(width, height, workCoordinate = this.getActiveWcsP()) {
        const x = -Math.abs(Number(width) || 0);
        const y = -Math.abs(Number(height) || 0);
        if (!x || !y) return null;

        const unitCmd = this.units === 'inch' ? 'G20' : 'G21';
        return `${unitCmd} G10 L2 P${workCoordinate} X${x.toFixed(3)} Y${y.toFixed(3)}`;
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

    isSpoilboardSetupComplete() {
        return this.spoilboardSetup.home && this.spoilboardSetup.z;
    }

    updateSpoilboardSetupUI() {
        const useMaxArea = !!document.getElementById('surf-dim-toggle')?.checked;
        const isConnected = !!window.ws?.isConnected;
        const checklist = document.getElementById('surf-spoilboard-setup-checklist');
        const generateBtn = document.getElementById('surf-generate-btn');
        const msg = document.getElementById('surf-setup-msg');

        if (checklist) checklist.classList.toggle('hidden', !useMaxArea);

        const nextStep = ['home', 'z'].find(step => !this.spoilboardSetup[step]);
        const connectBtn = document.getElementById('surf-setup-connect-btn');
        const homeBtn = document.getElementById('surf-setup-home-btn');
        const zActions = document.getElementById('surf-setup-z-actions');
        const zBtn = document.getElementById('surf-setup-z-btn');
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

        const complete = this.isSpoilboardSetupComplete();
        const ready = isConnected && complete;
        if (checklist) {
            checklist.classList.toggle('safe', ready);
            checklist.classList.toggle('unsafe', !ready);
        }
        if (msg) {
            if (!isConnected) msg.textContent = 'Connect to the machine before setup.';
            else if (complete) msg.textContent = 'Setup complete. Generate the spoilboard job when ready.';
            else if (nextStep === 'home') msg.innerHTML = 'Use <kbd class="inline-flex rounded border border-current px-1 font-mono text-[10px] leading-4">Home All</kbd>, then confirm once it is complete.';
            else msg.textContent = 'Please zero Z on the spoilboard, then confirm once it is complete.';
        }
        if (generateBtn) {
            generateBtn.disabled = useMaxArea && !ready;
            generateBtn.classList.toggle('opacity-50', generateBtn.disabled);
            generateBtn.classList.toggle('cursor-not-allowed', generateBtn.disabled);
        }
    }

    uploadToSD() {
        const gcode = this.generateGCode();
        if (gcode) {
            const file = new File([gcode], "surface.nc", { type: "text/plain" });
            this.sdHandler.startUpload(file);
        }
    }

    toggleDimMode() {
        const toggle = document.getElementById('surf-dim-toggle');
        if (toggle.checked) {
            this.autoSpoilboard();
        } else {
            this.saveSettings();
        }
        this._updateDimModeUI(toggle.checked);
        this.updateSpoilboardSetupUI();
    }

    autoSpoilboard() {
        if (!window.viewer || !window.viewer.machineLimits) {
            return;
        }

        this.saveSettings();
        const s = this.store.data.surfacing;

        let limits = window.viewer.machineLimits;
        let isPositiveSpace = window.viewer.isPositiveSpace || false;
        let homingDirMask = window.viewer.homingDirMask || 0;
        
        // Find xMin, yMin from how the viewer calculates machine box
        let xMin, xMax, yMin, yMax, zMax;

        if (isPositiveSpace) {
            if (homingDirMask & 1) { xMin = 0; xMax = limits.x; }
            else { xMin = -limits.x; xMax = 0; }

            if (homingDirMask & 2) { yMin = 0; yMax = limits.y; }
            else { yMin = -limits.y; yMax = 0; }
            
            if (homingDirMask & 4) { zMax = limits.z; }
            else { zMax = 0; }
        } else {
            // Standard approach
            xMin = -limits.x; xMax = 0;
            yMin = -limits.y; yMax = 0;
            zMax = 0;
        }

        let width = (xMax - xMin);
        let height = (yMax - yMin);

        if (width <= s.toolDiameter || height <= s.toolDiameter) {
            return;
        }

        // Set dimensions explicitly
        document.getElementById('surf-x').value = Number(width.toFixed(2));
        document.getElementById('surf-y').value = Number(height.toFixed(2));
        this.saveSettings();
        this._renderSpoilboardDimensions();
    }
}
