export class SurfacingHandler {
    constructor(viewer, sdHandler, term, store) {
        this.viewer = viewer;
        this.sdHandler = sdHandler;
        this.term = term;
        this.store = store;

        this.initUI();
    }

    initUI() {
        this.renderSettings();

        // Bind Inputs to Store on change
        const inputs = document.querySelectorAll('#surfacing-view input, #surfacing-view select');
        inputs.forEach(input => {
            input.addEventListener('change', () => this.saveSettings());
        });
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
    }

    renderSettings() {
        const s = this.store.data.surfacing;

        const setVal = (id, v) => {
            const el = document.getElementById(id);
            if(!el) return;
            if(el.type === 'checkbox') el.checked = v;
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
        if (s.toolDiameter <= 0.1) { alert("Tool Diameter must be greater than 0.1mm"); return null; }
        if (s.stepover <= 1) { alert("Stepover must be greater than 1%"); return null; }
        if (s.depthPerPass <= 0) { alert("Depth per pass must be greater than 0"); return null; }
        if (s.width <= 0 || s.height <= 0) { alert("Dimensions must be greater than 0"); return null; }
        if (s.finalDepth <= 0) { alert("Final Depth must be greater than 0"); return null; }

        let gcode = [];
        const comment = (msg) => gcode.push(`; ${msg}`);
        const cmd = (c) => gcode.push(c);

        // --- Header ---
        const d = new Date();
        comment(`Surfacing Job Generated: ${d.toLocaleTimeString()}`);
        comment(`Area: ${s.width}x${s.height}mm, Depth: ${s.finalDepth}mm`);
        comment(`Tool: ${s.toolDiameter}mm, Stepover: ${s.stepover}%`);
        comment(`Direction: ${s.direction === 'X' ? 'Along X' : 'Along Y'}`);

        cmd('G21 G90 G17');
        cmd('G54');

        if(s.rpm > 0) cmd(`M3 S${s.rpm}`);
        if(s.useCoolant) cmd('M8');

        cmd(`G0 Z${s.clearance}`);
        cmd('G0 X0 Y0');

        // --- Calculations ---
        const stepoverMm = s.toolDiameter * (s.stepover / 100.0);

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
            if(zSafety > 100) { alert("Z-Pass safety limit reached. Check depth settings."); break; }

            // Decrement Z
            currentZ -= zStep;

            // Clamp to target
            if(currentZ < targetZ) currentZ = targetZ;

            comment(`--- Pass Z: ${currentZ.toFixed(3)} ---`);

            // 1. Move to Start (0,0)
            if(isXDir) cmd(`G0 X${minMain.toFixed(3)} Y${minCross.toFixed(3)}`);
            else       cmd(`G0 X${minCross.toFixed(3)} Y${minMain.toFixed(3)}`);

            cmd(`G1 Z${currentZ.toFixed(3)} F${s.feed / 2}`);

            // 2. Zig Zag Routine
            let posCross = minCross;
            let goingForward = true;
            let xySafety = 0;

            // Loop until cross position reaches the end dimension
            while(posCross <= maxCross + 0.001) {
                xySafety++;
                if(xySafety > 10000) { alert("XY Loop safety limit reached."); break; }

                // Cut Main Axis
                const endMain = goingForward ? maxMain : minMain;
                if(isXDir) cmd(`G1 X${endMain.toFixed(3)} F${s.feed}`);
                else       cmd(`G1 Y${endMain.toFixed(3)} F${s.feed}`);

                // Check done
                if(posCross >= maxCross - 0.001) break;

                // Step Over
                posCross += stepoverMm;
                if(posCross > maxCross) posCross = maxCross; // Clamp last step

                // Move Cross Axis
                if(isXDir) cmd(`G1 Y${posCross.toFixed(3)}`);
                else       cmd(`G1 X${posCross.toFixed(3)}`);

                goingForward = !goingForward;
            }

            // 3. Optional Framing Pass
            if (s.useFraming) {
                comment("Framing Pass");
                cmd(`G0 Z${s.clearance}`);
                cmd(`G0 X0 Y0`);
                cmd(`G1 Z${currentZ.toFixed(3)} F${s.feed / 2}`);

                cmd(`G1 X${s.width.toFixed(3)} Y0 F${s.feed}`);
                cmd(`G1 X${s.width.toFixed(3)} Y${s.height.toFixed(3)}`);
                cmd(`G1 X0 Y${s.height.toFixed(3)}`);
                cmd(`G1 X0 Y0`);
            }

            cmd(`G0 Z${s.clearance}`);

            // Break if we just finished the final depth pass
            if (currentZ <= targetZ + 0.0001) break;
        }

        // --- Footer ---
        cmd('M5');
        if(s.useCoolant) cmd('M9');
        cmd('G0 X0 Y0');
        cmd('M30');

        return gcode.join('\n');
    }

    loadToViewer() {
        const gcode = this.generateGCode();
        if(gcode && window.viewer) {
            const event = new CustomEvent('gcode-loaded', { detail: gcode });
            window.dispatchEvent(event);

            window.viewer.processGCodeString(gcode);

            document.querySelector("button[onclick*='viewer-view']").click();
            this.term.writeln("\x1b[32m> Surfacing Job Loaded to Viewer.\x1b[0m");
        }
    }

    uploadToSD() {
        const gcode = this.generateGCode();
        if(gcode) {
            const file = new File([gcode], "surface.nc", { type: "text/plain" });
            this.sdHandler.startUpload(file);
        }
    }
}
