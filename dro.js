export class DROHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        // Initialize Units from Store
        this.isMm = this.store.get('general.units') === 'mm';

        // Coordinate State
        this.wco = [0, 0, 0, 0];
        this.wpos = [0, 0, 0, 0];
        this.mpos = [0, 0, 0, 0];

        this.spindleSpeed = 0;
        this.accessoryState = "";
        this.inputPins = "";

        // Initial UI Render
        this.updateUIUnits();
    }

    // --- Command Senders ---

    setZero(axis) {
        if (axis === 'XYZ') {
            this.ws.sendCommand('G10 L20 P0 X0 Y0 Z0');
        } else {
            this.ws.sendCommand(`G10 L20 P0 ${axis}0`);
        }
    }

    home() {
        if (!this.ws || !this.ws.isConnected) return;
        // Access the global reporter instance
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Run Homing Cycle', 'Run Homing Cycle ($H)? Ensure path is clear.', () => {
            this.ws.sendCommand('$H');
        });
    }

    goXY0() {
        this.ws.sendCommand('G0 X0 Y0');
    }

    setWCS(wcs) {
        this.ws.sendCommand(wcs);
        this.term.writeln(`\x1b[34m> Switched to ${wcs}\x1b[0m`);
    }

    goToPredefined(pos) {
        this.ws.sendCommand(`G${pos}`);
        this.term.writeln(`\x1b[34m> Moving to G${pos} Position\x1b[0m`);
    }

    setPredefined(pos) {
        if (!this.ws || !this.ws.isConnected) return;
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Set Position', `Set G${pos} location to current Machine Coordinates?`, () => {
            this.ws.sendCommand(`G${pos}.1`);
            this.term.writeln(`\x1b[32m> G${pos} Position Set.\x1b[0m`);
        });
    }

    toggleUnits() {
        const toggle = document.getElementById('unitToggle');
        this.isMm = toggle.checked;

        // Save to Store
        this.store.set('general.units', this.isMm ? 'mm' : 'in');

        // Update UI
        this.updateUIUnits();

        // Update Controller
        if (this.isMm) this.ws.sendCommand('G21');
        else this.ws.sendCommand('G20');

        this._updateAxisDisplay();
    }

    updateUIUnits() {
        // Toggle Switch
        const toggle = document.getElementById('unitToggle');
        if (toggle) toggle.checked = this.isMm;

        // Label
        const label = document.getElementById('unitLabel');
        if (label) label.innerText = this.isMm ? 'MM' : 'IN';

        // Step Options
        const select = document.getElementById('stepSize');
        if (select) {
            const mmSteps = [0.1, 1, 10, 100];
            const inSteps = [0.001, 0.01, 0.1, 1];
            const steps = this.isMm ? mmSteps : inSteps;
            const unit = this.isMm ? 'mm' : 'in';

            // Get Current Stored Preference
            const currentStep = parseFloat(this.store.get('jog.step')) || (this.isMm ? 10 : 0.1);

            select.innerHTML = '';
            let matchFound = false;

            steps.forEach((step) => {
                const opt = document.createElement('option');
                opt.value = step;
                opt.innerText = `${step} ${unit}`;
                if (step === currentStep) matchFound = true;
                select.appendChild(opt);
            });

            if (matchFound) select.value = currentStep;
            else select.selectedIndex = 2; // Default to middle option if mismatch
        }

        // Feedrate
        const feedInput = document.getElementById('feedRate');
        if (feedInput) {
            // Read from Store
            feedInput.value = this.store.get('jog.feed');
        }
    }

    parseStatus(line) {
        const content = line.substring(1, line.length - 1);
        const parts = content.split('|');

        // Extract State
        const statePart = parts[0];
        // this._updateStateBadge(statePart); // DEFERRED to end of parse

        this.spindleSpeed = 0;
        this.feedRate = 0;
        // this.accessoryState = ""; // PERSIST STATE (Change-based reporting)
        // this.inputPins = "";      // PERSIST STATE

        let rawWPos = null;
        let rawMPos = null;
        let feedOverride = null;
        let spindleOverride = null;
        let homedMask = 0;
        let isSdPrinting = false;
        // let foundAccessories = false; // DEBOUNCE REMOVED

        parts.forEach(part => {
            if (part.startsWith('WCO:')) {
                this.wco = part.split(':')[1].split(',').map(Number);
            } else if (part.startsWith('WPos:')) {
                rawWPos = part.split(':')[1].split(',').map(Number);
            } else if (part.startsWith('MPos:')) {
                rawMPos = part.split(':')[1].split(',').map(Number);
            }
            // Feed/Speed
            else if (part.startsWith('FS:')) {
                const speeds = part.substring(3).split(',');
                if (speeds.length >= 1) this.feedRate = parseFloat(speeds[0]) || 0;
                if (speeds.length === 3) this.spindleSpeed = parseFloat(speeds[2]) || 0;
                else if (speeds.length === 2) this.spindleSpeed = parseFloat(speeds[1]) || 0;
            }
            // Overrides
            else if (part.startsWith('Ov:')) {
                const overrides = part.substring(3).split(',');
                if (overrides.length >= 1) feedOverride = parseInt(overrides[0]) || 100;
                if (overrides.length >= 3) spindleOverride = parseInt(overrides[2]) || 100;
            }
            // --- NEW: Homing Status (H:mask,...) ---
            // grblHAL reports H:<homed_mask>,<homing_dir_mask>
            else if (part.startsWith('H:')) {
                const hParts = part.substring(2).split(',');
                homedMask = parseInt(hParts[0]) || 0;
                // We only care about homed_mask for now
            }
            // --- NEW: Input Pins (Pn:PXYZ...) ---
            else if (part.startsWith('Pn:')) {
                this.inputPins = part.substring(3);
            }
            // --- NEW: Accessories (A:SCFM) ---
            else if (part.startsWith('A:')) {
                this.accessoryState = part.substring(2);
                // foundAccessories = true;
            }
            // --- NEW: SD Status (SD:pct,file OR SD:status) ---
            else if (part.startsWith('SD:')) {
                const sdContent = part.substring(3);
                const sdParts = sdContent.split(',');

                // Case 1: Streaming Progress (pct, filename)
                if (sdParts.length >= 2) {
                    const pct = parseFloat(sdParts[0]);
                    const filename = sdParts[1];
                    isSdPrinting = true; // Flag as active
                    window.dispatchEvent(new CustomEvent('sd-status', { detail: { pct, filename } }));
                }
                // Case 2: Mount Status or Pending
                else if (sdParts.length === 1) {
                    const val = sdParts[0];
                    if (val === 'Pending') {
                        // Handle pending if needed
                    } else {
                        // Numeric Mount Status (0-3)
                        const state = parseInt(val);
                        if (!isNaN(state)) {
                            window.dispatchEvent(new CustomEvent('sd-mount-state', { detail: { state } }));
                        }
                    }
                }
            }
            // --- NEW: Line Number (Ln:xxxx) ---
            else if (part.startsWith('Ln:')) {
                const ln = parseInt(part.substring(3));
                if (!isNaN(ln)) {
                    window.dispatchEvent(new CustomEvent('gcode-line', { detail: { line: ln } }));
                }
            }
        });

        // Debounce Logic REMOVED (State Persists)

        // Update State Badge (Deferred to check isSdPrinting)
        this._updateStateBadge(statePart, isSdPrinting);

        // Calculate Position
        if (rawMPos) {
            this.mpos = rawMPos;
            this.wpos = this.mpos.map((v, i) => v - (this.wco[i] || 0));
        } else if (rawWPos) {
            this.wpos = rawWPos;
            this.mpos = this.wpos.map((v, i) => v + (this.wco[i] || 0));
        }

        // Update UI Components
        this._updateAxisDisplay();
        this._updateFeedSpindleDisplay(feedOverride, spindleOverride);
        this._updateHoming(homedMask); // NEW
        this._updatePins();            // NEW
        this._updateAccessories();     // NEW
    }

    // --- New Update Methods ---

    _updateHoming(mask) {
        // X=1, Y=2, Z=4, A=8, B=16, C=32
        const mapping = ['x', 'y', 'z', 'a', 'b', 'c'];
        mapping.forEach((axis, i) => {
            const isHomed = (mask >> i) & 1;
            const btn = document.getElementById(`homing-btn-${axis}`);
            if (btn) {
                if (isHomed) {
                    btn.classList.add('text-green-500');
                    btn.classList.remove('text-grey-light', 'text-red-400');
                    btn.title = `${axis.toUpperCase()} Homed`;
                } else {
                    // Use Red for unhomed as requested, or Gray?
                    // User said "green or red". Let's use Red to indicate "Not Homed" if standard.
                    // But usually unhomed is default state. I'll use Gray (faded) and Red only if we want to warn.
                    // Let's stick to Gray for "Not Homed" but make it clickable.
                    // Actually, let's use Red as "Needs Homing" style?
                    // I will use Gray for now as it's safer UI design, unless user insists on Red.
                    // User asked "green or red?". I'll implementation Green (Homed) and Gray (Unhomed).
                    btn.classList.remove('text-green-500', 'text-red-400');
                    btn.classList.add('text-grey-light');
                    btn.title = `Home ${axis.toUpperCase()}`;
                }
            }
        });
    }

    _updatePins() {
        // Pins: X, Y, Z, P, D, H, R, S
        // ID convention: pin-indicator-{char}
        const pinChars = ['X', 'Y', 'Z', 'P', 'D', 'H', 'R', 'S'];
        pinChars.forEach(char => {
            const el = document.getElementById(`pin-indicator-${char}`);
            if (el) {
                if (this.inputPins.includes(char)) {
                    el.classList.add('bg-red-500', 'text-white', 'border-red-600');
                    el.classList.remove('bg-grey-light/20', 'text-grey-light', 'border-grey-light');
                } else {
                    el.classList.remove('bg-red-500', 'text-white', 'border-red-600');
                    el.classList.add('bg-grey-light/20', 'text-grey-light', 'border-grey-light');
                }
            }
        });
    }

    _updateAccessories() {
        // A: S(CW), C(CCW), F(Flood), M(Mist)
        const mapping = {
            'S': 'acc-spindle', // Icon generic spindle? Or direction?
            'C': 'acc-spindle', // Both map to spindle icon, maybe change icon?
            'F': 'acc-flood',
            'M': 'acc-mist'
        };

        // Reset all first? Or check presence
        // Spindle (CW/CCW)
        const sEl = document.getElementById('acc-spindle');
        if (sEl) {
            if (this.accessoryState.includes('S')) {
                sEl.classList.add('text-green-500', 'animate-spin-slow'); // CW
                sEl.classList.remove('text-grey-light');
            } else if (this.accessoryState.includes('C')) {
                sEl.classList.add('text-yellow-500', 'animate-spin-reverse'); // CCW
                sEl.classList.remove('text-grey-light');
            } else {
                sEl.classList.remove('text-green-500', 'text-yellow-500', 'animate-spin-slow', 'animate-spin-reverse');
                sEl.classList.add('text-grey-light');
            }
        }

        ['F', 'M'].forEach(char => {
            const id = mapping[char];
            const el = document.getElementById(id);
            if (el) {
                if (this.accessoryState.includes(char)) {
                    el.classList.add('text-blue-500');
                    el.classList.remove('text-grey-light');
                } else {
                    el.classList.remove('text-blue-500');
                    el.classList.add('text-grey-light');
                }
            }
        });
    }

    homeAxis(axis) {
        if (!this.ws || !this.ws.isConnected) return;
        this.ws.sendCommand(`$H${axis}`);
    }

    // ... existing methods ...



    _updateStateBadge(state, isSdPrinting = false) {
        const stateEl = document.getElementById('machine-state');
        if (!stateEl) return;
        const cleanState = state.split(':')[0];
        stateEl.textContent = cleanState;
        stateEl.className = "text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-white transition-all duration-300";
        const s = cleanState.toLowerCase();

        if (s.startsWith('alarm')) {
            stateEl.classList.add('bg-red-600', 'animate-pulse', 'shadow-lg', 'shadow-red-500/50');
        } else if (s.startsWith('hold') || s.startsWith('door') || s.startsWith('sleep')) {
            stateEl.classList.add('bg-yellow-600');
        } else if (s.startsWith('run') || s.startsWith('jog') || s.startsWith('homing')) {
            stateEl.classList.add('bg-green-600');
        } else {
            stateEl.classList.add('bg-secondary');
        }

        // Check for Idle to reset SD UI (Only if NOT printing)
        if (s === 'idle' && !isSdPrinting) {
            window.dispatchEvent(new CustomEvent('sd-job-complete'));
        }
    }

    _updateAxisDisplay() {
        const axes = ['x', 'y', 'z', 'a'];
        axes.forEach((axis, i) => {
            const elW = document.getElementById(`dro-${axis}`);   // Work
            const elM = document.getElementById(`dro-${axis}-m`); // Machine
            if (elW) {
                let wVal = this.wpos[i] !== undefined ? this.wpos[i] : 0;
                let mVal = this.mpos[i] !== undefined ? this.mpos[i] : 0;
                if (!this.isMm) {
                    wVal = wVal / 25.4;
                    mVal = mVal / 25.4;
                }
                const decimals = this.isMm ? 3 : 4;
                elW.textContent = wVal.toFixed(decimals);
                if (elM) elM.textContent = mVal.toFixed(decimals);

                if (axis === 'a') {
                    if (this.wpos.length > 3) {
                        elW.closest('.dro-row').classList.remove('hidden');
                        elW.closest('.dro-row').classList.add('flex');
                    } else {
                        elW.closest('.dro-row').classList.add('hidden');
                        elW.closest('.dro-row').classList.remove('flex');
                    }
                }
            }
        });
    }

    _updateFeedSpindleDisplay(feedOverride, spindleOverride) {
        // Update Spindle RPM
        const spindleRpmEl = document.getElementById('spindle-rpm');
        if (spindleRpmEl) {
            spindleRpmEl.textContent = Math.round(this.spindleSpeed || 0);
        }

        // Update Spindle Override % (only if present in report)
        const spindleOvrEl = document.getElementById('spindle-ovr');
        if (spindleOvrEl && spindleOverride !== null) {
            spindleOvrEl.textContent = `${spindleOverride}%`;
        }

        // Update Feedrate with unit conversion
        const feedRateEl = document.getElementById('feed-rate');
        const feedRateUnitEl = document.getElementById('feed-rate-unit');
        if (feedRateEl) {
            let feedValue = this.feedRate || 0;
            let unit = 'mm/min';

            // Convert to inches per minute if in inch mode
            if (!this.isMm) {
                feedValue = feedValue / 25.4;
                unit = 'in/min';
            }

            feedRateEl.textContent = Math.round(feedValue);
            if (feedRateUnitEl) {
                feedRateUnitEl.textContent = unit;
            }
        }

        // Update Feed Override % (only if present in report)
        const feedOvrEl = document.getElementById('feed-ovr');
        if (feedOvrEl && feedOverride !== null) {
            feedOvrEl.textContent = `${feedOverride}%`;
        }
    }
}
