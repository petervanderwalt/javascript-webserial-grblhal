export class SurfacingHandler {
    constructor(viewer, sdHandler, term, store) {
        this.viewer = viewer;
        this.sdHandler = sdHandler;
        this.term = term;
        this.store = store;

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
        const inputs = document.querySelectorAll('#surfacing-view input, #surfacing-view select');
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
        const labels = document.querySelectorAll('#surfacing-view label');
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

        // Save the current units context
        this.store.set('surfacing.units', this.units);
    }

    renderSettings() {
        const s = this.store.data.surfacing;

        // Apply Unit Labels based on store state (or just current state)
        // Since we synced in constructor, s.units should match this.units.
        // But we need to ensure labels match what's in the input boxes.
        const isMM = (this.units === 'mm');
        const labels = document.querySelectorAll('#surfacing-view label');
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
    }

    generateGCode() {
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
        if (s.width <= 0 || s.height <= 0) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(null) : null);
            if (reporter) {
                reporter.showAlert('Invalid Dimensions', 'Dimensions must be greater than 0');
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

        if (s.rpm > 0) cmd(`M3 S${s.rpm}`);
        if (s.useCoolant) cmd('M8');

        // Fmt helper for coordinate precision
        const fmt = (n) => n.toFixed(this.units === 'mm' ? 3 : 4);

        cmd(`G0 Z${fmt(s.clearance)}`);
        cmd('G0 X0 Y0');

        // --- Calculations ---
        const stepoverVal = s.toolDiameter * (s.stepover / 100.0);

        const isXDir = (s.direction === 'X');

        // STRICT BOUNDS (No Overshoot)
        const minMain = 0;
        const maxMain = (isXDir ? s.width : s.height);

        const minCross = 0;
        const maxCross = (isXDir ? s.height : s.width);

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
                cmd(`G0 X0 Y0`);
                cmd(`G1 Z${fmt(currentZ)} F${s.feed / 2}`);

                cmd(`G1 X${fmt(s.width)} Y0 F${s.feed}`);
                cmd(`G1 X${fmt(s.width)} Y${fmt(s.height)}`);
                cmd(`G1 X0 Y${fmt(s.height)}`);
                cmd(`G1 X0 Y0`);
            }

            cmd(`G0 Z${fmt(s.clearance)}`);

            // Break if we just finished the final depth pass
            if (currentZ <= targetZ + 0.0001) break;
        }

        // --- Footer ---
        cmd('M5');
        if (s.useCoolant) cmd('M9');
        cmd('G0 X0 Y0');
        cmd('M30');

        return gcode.join('\n');
    }

    loadToViewer() {
        const gcode = this.generateGCode();
        if (gcode && window.viewer) {
            const event = new CustomEvent('gcode-loaded', { detail: gcode });
            window.dispatchEvent(event);

            window.viewer.processGCodeString(gcode);

            document.querySelector("button[onclick*='viewer-view']").click();
            this.term.writeln("\x1b[32m> Surfacing Job Loaded to Viewer.\x1b[0m");
        }
    }

    uploadToSD() {
        const gcode = this.generateGCode();
        if (gcode) {
            const file = new File([gcode], "surface.nc", { type: "text/plain" });
            this.sdHandler.startUpload(file);
        }
    }
}
