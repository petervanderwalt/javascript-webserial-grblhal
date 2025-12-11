// Default Grbl 1.1 + GrblHAL Extended Errors
// Sources: gnea/grbl Wiki & grblHAL/core errors.h
const STANDARD_ERRORS = {
    '1': 'Expected command letter: G-code words consist of a letter and a value. Letter was not found.',
    '2': 'Bad number format: Missing the expected G-code word value or numeric value format is not valid.',
    '3': 'Invalid statement: Grbl \'$\' system command was not recognized or supported.',
    '4': 'Value < 0: Negative value received for an expected positive value.',
    '5': 'Setting disabled: Homing cycle failure. Homing is not enabled via settings.',
    '6': 'Value < 3 usec: Minimum step pulse time must be greater than 3usec.',
    '7': 'EEPROM read fail: An EEPROM read failed. Auto-restoring affected EEPROM to default values.',
    '8': 'Not idle: Grbl \'$\' command cannot be used unless Grbl is IDLE. Ensures smooth operation during a job.',
    '9': 'G-code lock: G-code commands are locked out during alarm or jog state.',
    '10': 'Homing not enabled: Soft limits cannot be enabled without homing also enabled.',
    '11': 'Line overflow: Max characters per line exceeded. Received command line was not executed.',
    '12': 'Step rate > 30kHz: Grbl \'$\' setting value cause the step rate to exceed the maximum supported.',
    '13': 'Check Door: Safety door detected as opened and door state initiated.',
    '14': 'Line length exceeded: Build info or startup line exceeded EEPROM line length limit. Line not stored.',
    '15': 'Travel exceeded: Jog target exceeds machine travel. Jog command has been ignored.',
    '16': 'Invalid jog command: Jog command has no \'=\' or contains prohibited g-code.',
    '17': 'Laser mode requires PWM output.',
    '18': 'Reset asserted: A reset was issued.',
    '19': 'Non positive value: A negative or zero value was found where a positive value is required.',
    '20': 'Unsupported command: Unsupported or invalid g-code command found in block.',
    '21': 'Modal group violation: More than one g-code command from same modal group found in block.',
    '22': 'Undefined feed rate: Feed rate has not yet been set or is undefined.',
    '23': 'Command requires integer: G-code command in block requires an integer value.',
    '24': 'Axis command conflict: More than one g-code command that requires axis words found in block.',
    '25': 'Word repeated: Repeated g-code word found in block.',
    '26': 'No axis words: No axis words found in block for g-code command or current modal state which requires them.',
    '27': 'Invalid line number: Line number value is invalid.',
    '28': 'Value missing: G-code command is missing a required value word.',
    '29': 'G59.x WCS not supported: Grbl supports G54-G59 work coordinate systems. G59.1, G59.2, and G59.3 are not supported.',
    '30': 'G53 invalid: G53 only allowed with G0 and G1 motion modes.',
    '31': 'Axis words found in G80: Axis words found in block when no command or current modal state uses them.',
    '32': 'G2/G3 arcs require at least one in-plane axis word.',
    '33': 'Motion target invalid: Motion command target is invalid.',
    '34': 'Arc radius value is invalid.',
    '35': 'G2 and G3 arcs require at least one in-plane offset word.',
    '36': 'Unused value words found in block.',
    '37': 'G43.1 dynamic tool length offset is not assigned to configured tool length axis.',
    '38': 'Tool number greater than max supported value.',
    '39': 'P parameter value is too large.',

    // GrblHAL Specific Errors
    '40': 'Tool change pending: G-code command not allowed when tool change is pending.',
    '41': 'Spindle not running: Spindle not running when motion commanded in CSS or spindle sync mode.',
    '42': 'Plane must be ZX for threading.',
    '43': 'Max feed rate exceeded.',
    '44': 'RPM out of range.',
    '45': 'Limits engaged: Only homing is allowed when a limit switch is engaged.',
    '46': 'Homing required: Home machine to continue.',
    '47': 'ATC error: Current tool is not set. Set current tool with M61.',
    '48': 'Value word conflict.',
    '49': 'Power on self test failed.',
    '50': 'Emergency stop active.',
    '51': 'Motor fault.',
    '52': 'Setting value out of range.',
    '53': 'Setting not available.',
    '54': 'Retract < drill depth.',
    '55': 'Auto squared axis conflict.',
    '56': 'Coordinate system locked.',
    '57': 'Unexpected file demarcation.',
    '58': 'Port not available.',
    '60': 'SD Card mount failed.',
    '61': 'File delete failed.',
    '62': 'Directory listing failed.',
    '63': 'Directory not found.',
    '64': 'File empty or SD Card not mounted.',
    '65': 'File system not mounted.',
    '66': 'File system is read only.',
    '70': 'Bluetooth failed to start.',
    '71': 'Unknown operation found in expression.',
    '72': 'Divide by zero in expression attempted.',
    '73': 'Too large or too small argument provided.',
    '74': 'Argument is not valid for the operation.',
    '75': 'Expression is not valid.',
    '76': 'Either NAN (not a number) or infinity was returned from expression.',
    '77': 'Authentication required.',
    '78': 'Access denied.',
    '79': 'Not allowed while critical event is active.',
    '80': 'Flow statement only allowed in macro.',
    '81': 'Unknown flow statement.',
    '82': 'Stack overflow.',
    '83': 'Out of memory.',
    '84': 'Could not open file.',
    '85': 'File system format failed.',
    '86': 'Port is not usable.',
    '253': 'User defined error.'
};

const STANDARD_ALARMS = {
    '1': 'Hard limit: Machine position is likely lost due to sudden halt. Re-homing is highly recommended.',
    '2': 'Soft limit: G-code motion target exceeds machine travel. Machine position retained. Alarm may be safely unlocked.',
    '3': 'Abort during cycle: Machine position is likely lost due to sudden halt. Re-homing is highly recommended.',
    '4': 'Probe fail: Probe is not in the expected initial state before starting probe cycle.',
    '5': 'Probe fail: Probe did not contact the workpiece within the programmed travel.',
    '6': 'Homing fail: Reset during active homing cycle.',
    '7': 'Homing fail: Safety door was opened during active homing cycle.',
    '8': 'Homing fail: Cycle failed to clear limit switch when pulling off.',
    '9': 'Homing fail: Could not find limit switch within search distance.',

    // GrblHAL Specific Alarms
    '10': 'EStop asserted: Clear and reset.',
    '11': 'Homing required: Execute homing command ($H) to continue.',
    '12': 'Limit switch engaged: Clear before continuing.',
    '13': 'Probe protection triggered: Clear before continuing.',
    '14': 'Spindle at speed timeout: Clear before continuing.',
    '15': 'Auto square fail: Could not find second limit switch for auto squared axis.',
    '16': 'POS failed: Power on self test failed.',
    '17': 'Motor fault.',
    '18': 'Homing bad config.',
    '19': 'Modbus exception: Timeout or message error.',
    '20': 'I/O expander fail: Communication failed.'
};

export class AlarmsAndErrors {
    /**
     * @param {Object} ws - The WebSerial instance for sending Unlock/Reset commands
     */
    constructor(ws) {
        this.ws = ws;
        this.errors = { ...STANDARD_ERRORS };
        this.alarms = { ...STANDARD_ALARMS };

        // Initialize the DOM elements for the modal
        this.initModal();
    }

    initModal() {
        if (document.getElementById('cnc-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'cnc-modal-overlay';
        overlay.className = 'fixed inset-0 bg-black/50 backdrop-blur-sm z-50 hidden flex items-center justify-center';

        overlay.innerHTML = `
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all scale-100 p-0 border border-grey-light">
                <!-- Header -->
                <div id="cnc-modal-header" class="px-6 py-4 border-b border-grey-light flex items-center gap-3">
                    <i id="cnc-modal-icon" class="bi text-xl"></i>
                    <h3 id="cnc-modal-title" class="font-bold text-lg text-secondary-dark">Title</h3>
                </div>

                <!-- Body -->
                <div class="px-6 py-6">
                    <p id="cnc-modal-body" class="text-sm font-bold text-grey-dark leading-relaxed"></p>
                </div>

                <!-- Footer -->
                <div id="cnc-modal-footer" class="bg-grey-bg px-6 py-3 flex justify-end gap-2 border-t border-grey-light">
                    <!-- Buttons injected via JS -->
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.domTitle = overlay.querySelector('#cnc-modal-title');
        this.domBody = overlay.querySelector('#cnc-modal-body');
        this.domFooter = overlay.querySelector('#cnc-modal-footer');
        this.domIcon = overlay.querySelector('#cnc-modal-icon');
        this.domHeader = overlay.querySelector('#cnc-modal-header');
    }

    showModal(type, code, message) {
        // Configure styles based on type
        if (type === 'ERROR') {
            this.domHeader.className = "px-6 py-4 border-b border-red-100 bg-red-50 flex items-center gap-3";
            this.domIcon.className = "bi bi-exclamation-octagon-fill text-red-500 text-xl";
            this.domTitle.textContent = `Error ${code}`;
            this.domTitle.className = "font-bold text-lg text-red-700";
        } else {
            this.domHeader.className = "px-6 py-4 border-b border-primary/20 bg-primary/10 flex items-center gap-3";
            this.domIcon.className = "bi bi-exclamation-triangle-fill text-primary-dark text-xl";
            this.domTitle.textContent = `Alarm ${code}`;
            this.domTitle.className = "font-bold text-lg text-secondary-dark";
        }

        this.domBody.textContent = message;
        this.domFooter.innerHTML = ''; // Clear buttons

        // Create Buttons
        if (type === 'ERROR') {
            const btnOk = this.createBtn('OK', 'bg-secondary text-white hover:bg-secondary-dark', () => this.closeModal());
            this.domFooter.appendChild(btnOk);
        } else {
            // Alarm Buttons
            const btnCancel = this.createBtn('Cancel', 'bg-white border border-grey-light text-grey-dark hover:text-black', () => this.closeModal());
            const btnClear = this.createBtn('Clear Alarm', 'bg-primary text-black hover:bg-primary-dark border border-primary-dark/20', () => {
                this.performUnlock();
                this.closeModal();
            });

            this.domFooter.appendChild(btnCancel);
            this.domFooter.appendChild(btnClear);
        }

        this.overlay.classList.remove('hidden');
    }

    closeModal() {
        this.overlay.classList.add('hidden');
    }

    createBtn(text, classes, onClick) {
        const btn = document.createElement('button');
        btn.className = `px-4 py-2 rounded-lg text-sm font-bold transition-colors ${classes}`;
        btn.textContent = text;
        btn.onclick = onClick;
        return btn;
    }

    performUnlock() {
        // Send Soft Reset then Unlock
        if(this.ws) {
            setTimeout(() => {
                this.ws.sendCommand('$X'); // Unlock
            }, 100);
        }
    }

    /**
     * Processes a line to see if it is an Error Definition, Alarm Definition,
     * Active Error report, or Active Alarm report.
     *
     * @param {string} line - The raw line from serial
     * @returns {string|boolean} - Returns a formatted string to print to console,
     *                             true if handled silently (definitions),
     *                             or false if not handled.
     */
    handleLine(line) {
        if (!line) return false;

        // 1. GrblHAL Error Definition ([ERRORCODE:1||Desc])
        if (line.startsWith('[ERRORCODE:')) {
            const inner = line.substring(11, line.length - 1);
            const parts = inner.split('||');
            if (parts.length >= 2) {
                this.errors[parts[0]] = parts[1];
            }
            return true; // Handled silently
        }

        // 2. GrblHAL Alarm Definition ([ALARMCODE:1||Desc])
        if (line.startsWith('[ALARMCODE:')) {
            const inner = line.substring(11, line.length - 1);
            const parts = inner.split('||');
            if (parts.length >= 2) {
                this.alarms[parts[0]] = parts[1];
            }
            return true; // Handled silently
        }

        // 3. Standard Grbl Error Definition ([ERR:1:Desc])
        if (line.startsWith('[ERR:')) {
            const inner = line.substring(5, line.length - 1);
            const splitIdx = inner.indexOf(':');
            if (splitIdx !== -1) {
                this.errors[inner.substring(0, splitIdx).trim()] = inner.substring(splitIdx + 1).trim();
            }
            return true;
        }

        // 4. Standard Grbl Alarm Definition ([ALM:1:Desc])
        if (line.startsWith('[ALM:')) {
            const inner = line.substring(5, line.length - 1);
            const splitIdx = inner.indexOf(':');
            if (splitIdx !== -1) {
                this.alarms[inner.substring(0, splitIdx).trim()] = inner.substring(splitIdx + 1).trim();
            }
            return true;
        }

        // 5. Active Error Report (error:X)
        if (line.toLowerCase().startsWith('error:')) {
            const parts = line.split(':');
            const code = parts[1] ? parts[1].trim() : 'Unknown';
            const desc = this.errors[code] || "Unknown Error";
            const msg = desc;

            this.showModal('ERROR', code, msg);
            return `\x1b[31mError ${code}: ${desc}\x1b[0m`;
        }

        // 6. Active Alarm Report (alarm:X)
        if (line.toLowerCase().startsWith('alarm:')) {
            const parts = line.split(':');
            const code = parts[1] ? parts[1].trim() : 'Unknown';
            const desc = this.alarms[code] || "Unknown Alarm";
            const msg = desc;

            this.showModal('ALARM', code, msg);
            return `\x1b[33mAlarm ${code}: ${desc}\x1b[0m`;
        }

        return false; // Not an error or alarm line
    }
}
