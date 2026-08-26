export class DROHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        // Initialize Units from Store
        this.isMm = this.store.get('general.units') === 'mm';

        // Coordinate State
        this.wco = [];
        this.wpos = [];
        this.mpos = [];

        this.spindleSpeed = 0;
        this.accessoryState = "";
        this.inputPins = "";
        this.status = "Disconnected";
        this._lastState = "";

        // Initial UI Render
        this.updateUIUnits();
    }

    // --- Command Senders ---

    _requireConnectedForAction() {
        if (this.ws && this.ws.isConnected) return true;
        if (window.showToast) window.showToast('Machine not connected', 'plug-zap', 'error');
        return false;
    }

    setZero(axis) {
        if (!this._requireConnectedForAction()) return;
        if (axis === 'XYZ') {
            this.ws.sendCommand('G10 L20 P0 X0 Y0 Z0');
        } else {
            this.ws.sendCommand(`G10 L20 P0 ${axis}0`);
        }
    }

    home() {
        if (!this._requireConnectedForAction()) return;
        // Access the global reporter instance
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Run Homing Cycle', 'Run Homing Cycle ($H)? It will first Home Z, then Home X, then Home Y. Ensure the path is clear.', () => {
            this.ws.sendCommand('$H');
        });
    }

    goXY0() {
        if (!this._requireConnectedForAction()) return;
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        const originalMachineZ = Number.isFinite(this.mpos[2]) ? this.mpos[2] : null;
        reporter.showConfirm('Go To XY Zero', 'Go to X0 Y0? It will first raise Z, then move X, then move Y, then return Z to its original position. Ensure the path is clear.', () => {
            this.ws.sendCommand('G53 G0 Z-5');
            this.ws.sendCommand('G0 X0');
            this.ws.sendCommand('G0 Y0');
            if (originalMachineZ !== null) {
                this.ws.sendCommand(`G53 G0 Z${originalMachineZ}`);
            }
        });
    }

    goZ0() {
        if (!this._requireConnectedForAction()) return;
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Go To Z Zero', 'Move to Z0? Ensure the path is clear.', () => {
            this.ws.sendCommand('G0 Z0');
        });
    }

    setWCS(wcs) {
        this.ws.sendCommand(wcs);
        this.term.writeln(`\x1b[34m> Switched to ${wcs}\x1b[0m`);
    }

    goToPredefined(pos) {
        if (!this._requireConnectedForAction()) return;
        this.ws.sendCommand(`G${pos}`);
        this.term.writeln(`\x1b[34m> Moving to G${pos} Position\x1b[0m`);
    }

    setPredefined(pos) {
        if (!this._requireConnectedForAction()) return;
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
        this.isMm = !toggle.checked;

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
        if (toggle) toggle.checked = !this.isMm;

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
            const val = this.store.get('jog.speedMode');
            feedInput.value = (val === 'fast' || val === 'med' || val === 'slow') ? val : 'slow';
        }
    }

    parseStatus(line) {
        const content = line.substring(1, line.length - 1);
        const parts = content.split('|');

        // Extract State
        const statePart = parts[0];
        this.status = statePart.split(':')[0];
        // this._updateStateBadge(statePart); // DEFERRED to end of parse

        this.spindleSpeed = 0;
        this.feedRate = 0;
        this.inputPins = "";

        let rawWPos = null;
        let rawMPos = null;
        let feedOverride = null;
        let spindleOverride = null;
        let rapidOverride = null;
        let homedMask = this.homedMask || 0;
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
                if (overrides.length >= 2) rapidOverride = parseInt(overrides[1]) || 100;
                if (overrides.length >= 3) spindleOverride = parseInt(overrides[2]) || 100;
            }
            // Homing Status:
            // H:0            -> homing not complete
            // H:1            -> all active axes homed
            // H:1,<bitmask>  -> single-axis homing enabled, bitmask says which axes are homed
            else if (part.startsWith('H:')) {
                const hParts = part.substring(2).split(',');
                const homingComplete = parseInt(hParts[0]) || 0;
                if (hParts.length > 1) {
                    homedMask = parseInt(hParts[1]) || 0;
                } else if (homingComplete) {
                    const axisCount = Math.max(this.mpos.length, this.wpos.length, 3);
                    homedMask = (1 << Math.min(axisCount, 6)) - 1;
                } else {
                    homedMask = 0;
                }
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
            // --- NEW: INA219 Power Monitor ---
            else if (part.startsWith('INA219:')) {
                const values = part.substring(7).split(',');
                if (values.length >= 2) {
                    const voltage = parseFloat(values[0]);
                    const current = parseFloat(values[1]);
                    if (!isNaN(voltage) && !isNaN(current)) {
                        this.ina219Voltage = voltage;
                        this.ina219Current = current;
                        if (window.troubleshooting) {
                            window.troubleshooting.updateINA219(voltage, current);
                        }
                    }
                }
            }
            // --- NEW: Active Alarm (Alarm:X) from extended status report (0x87) ---
            else if (part.startsWith('Alarm:')) {
                const alarmCode = part.substring(6).trim();
                if (alarmCode && alarmCode !== '0') {
                    // Dispatch event to update alarm tracking in alarms_and_errors.js
                    window.dispatchEvent(new CustomEvent('active-alarm', { detail: { code: alarmCode } }));
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
        this._updateFeedSpindleDisplay(feedOverride, spindleOverride, rapidOverride);
        this._updateHoming(homedMask); // NEW
        this._updatePins();            // NEW
        this._updateAccessories();     // NEW
    }

    // --- New Update Methods ---

    _updateHoming(mask) {
        this.homedMask = mask;
        // X=1, Y=2, Z=4, A=8, B=16, C=32
        const mapping = ['x', 'y', 'z', 'a', 'b', 'c'];
        mapping.forEach((axis, i) => {
            const isHomed = (mask >> i) & 1;
            const btn = document.getElementById(`homing-btn-${axis}`);
            if (btn) {
                btn.classList.remove('text-green-500', 'text-red-400');
                btn.classList.add('text-grey-light');
                btn.title = isHomed ? `${axis.toUpperCase()} Homed` : `Home ${axis.toUpperCase()}`;
            }
        });
        if (window.troubleshooting) {
            window.troubleshooting.updateHoming(mask);
        }
    }

    _updatePins() {
        if (window.troubleshooting) {
            window.troubleshooting.updatePins(this.inputPins);
        }
    }

    _updateAccessories() {
        // A: S(CW), C(CCW), F(Flood), M(Mist)
        const mapping = {
            'S': 'acc-spindle',
            'C': 'acc-spindle',
            'F': 'acc-flood',
            'M': 'acc-mist'
        };

        const sEl = document.getElementById('acc-spindle');
        if (sEl) {
            const iconEl = sEl.querySelector('svg, i, [data-lucide]');
            if (this.accessoryState.includes('S')) {
                sEl.classList.add('active');
                iconEl?.classList.remove('animate-spin-reverse');
                iconEl?.classList.add('animate-spin-slow');
            } else if (this.accessoryState.includes('C')) {
                sEl.classList.add('active');
                iconEl?.classList.remove('animate-spin-slow');
                iconEl?.classList.add('animate-spin-reverse');
            } else {
                sEl.classList.remove('active');
                iconEl?.classList.remove('animate-spin-slow', 'animate-spin-reverse');
            }
        }

        ['F', 'M'].forEach(char => {
            const id = mapping[char];
            const el = document.getElementById(id);
            if (el) {
                const iconEl = el.querySelector('svg, i, [data-lucide]');
                if (this.accessoryState.includes(char)) {
                    el.classList.add('active');
                    if (char === 'F') iconEl?.classList.add('animate-flood-flow');
                } else {
                    el.classList.remove('active');
                    if (char === 'F') iconEl?.classList.remove('animate-flood-flow');
                }
            }
        });
    }

    _setAccessoryState(char, enabled) {
        const state = new Set((this.accessoryState || '').split('').filter(Boolean));
        if (enabled) state.add(char);
        else state.delete(char);
        this.accessoryState = Array.from(state).join('');
        this._updateAccessories();
    }

    toggleAccessory(type) {
        if (!this.ws || !this.ws.isConnected) { if (window.showToast) window.showToast('Not connected', 'plug-zap', 'error'); return; }
        var isActive = this.accessoryState ? this.accessoryState.includes(type) : false;
        if (type === 'F') {
            if (isActive) {
                this.ws.sendCommand('M9');
                this._setAccessoryState('F', false);
                this._setAccessoryState('M', false);
                if (window.showToast) window.showToast('Coolant off', 'droplet', 'success');
            } else {
                this.ws.sendCommand('M8');
                this._setAccessoryState('F', true);
                if (window.showToast) window.showToast('Flood on', 'droplet', 'success');
            }
        } else if (type === 'M') {
            if (isActive) {
                this.ws.sendCommand('M9');
                this._setAccessoryState('F', false);
                this._setAccessoryState('M', false);
                if (window.showToast) window.showToast('Coolant off', 'cloud-fog', 'success');
            } else {
                this.ws.sendCommand('M7');
                this._setAccessoryState('M', true);
                if (window.showToast) window.showToast('Mist on', 'cloud-fog', 'success');
            }
        } else if (type === 'S') {
            if (isActive) {
                this.ws.sendCommand('M5');
                this._setAccessoryState('S', false);
                this._setAccessoryState('C', false);
                if (window.showToast) window.showToast('Spindle off', 'fan', 'success');
            } else {
                this.ws.sendCommand('M3');
                this._setAccessoryState('S', true);
                this._setAccessoryState('C', false);
                if (window.showToast) window.showToast('Spindle on', 'fan', 'success');
            }
        }
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
        stateEl.className = "machine-status-pill text-center transition-all duration-300";
        const s = cleanState.toLowerCase();
        window.dispatchEvent(new CustomEvent('machine-state-changed', { detail: { state: s } }));

        // Detect alarm → non-alarm transition (alarm cleared via $X or reset)
        const wasAlarmed = this._lastState && this._lastState.startsWith('alarm');
        this._lastState = s;
        if (wasAlarmed && !s.startsWith('alarm')) {
            window.dispatchEvent(new CustomEvent('machine-alarm-cleared'));
        }

        const isAlarmed = s.startsWith('alarm');

        if (isAlarmed) {
            stateEl.classList.add('status-alarm', 'animate-pulse');
        } else if (s.startsWith('hold') || s.startsWith('door') || s.startsWith('sleep')) {
            stateEl.classList.add('status-warn');
        } else if (s.startsWith('run') || s.startsWith('jog') || s.startsWith('homing')) {
            stateEl.classList.add('status-run');
        } else {
            stateEl.classList.add('status-idle');
        }

        if (window.uiManager && window.uiManager.applyStateLock) {
            window.uiManager.applyStateLock(s);
        }

        // Check for Idle to reset SD UI (Only if NOT printing)
        if (s === 'idle' && !isSdPrinting) {
            window.dispatchEvent(new CustomEvent('sd-job-complete'));
            window.dispatchEvent(new CustomEvent('machine-idle'));
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
                    const jogAPad = document.getElementById('jog-a-pad');
                    if (this.wpos.length > 3) {
                        elW.closest('.dro-row').classList.remove('hidden');
                        elW.closest('.dro-row').classList.add('flex');
                        if (jogAPad) jogAPad.style.display = '';
                    } else {
                        elW.closest('.dro-row').classList.add('hidden');
                        elW.closest('.dro-row').classList.remove('flex');
                        if (jogAPad) jogAPad.style.display = 'none';
                    }
                }
            }
        });
    }

    _updateFeedSpindleDisplay(feedOverride, spindleOverride, rapidOverride) {
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

        // Update Rapids Override % (only if present in report)
        const rapidOvrEl = document.getElementById('rapid-ovr');
        if (rapidOvrEl && rapidOverride !== null) {
            rapidOvrEl.textContent = `${rapidOverride}%`;
        }
    }
}
