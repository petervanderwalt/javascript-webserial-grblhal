import { registerModal } from './modal.js';

export class MacroHandler {
    constructor(ws, term) {
        this.ws = ws;
        this.term = term;
        this.macros = [];
        this.editingId = null; // null = new, number = editing index

        // Predefined list of useful Lucide icons for CNC
        this.icons = [
            'play', 'square', 'pause', 'house',
            'fan', 'droplets', 'zap', 'wrench',
            'crosshair', 'move', 'rotate-cw', 'rotate-ccw',
            'lightbulb', 'package', 'ruler', 'settings',
            'wind', 'thermometer', 'gauge', 'trash-2'
        ];

        this.colors = [
            { name: 'Orange', accent: '#FF6600', soft: '#FFF0E5', border: '#FF6600' },
            { name: 'Green', accent: '#16A34A', soft: '#E9F9EF', border: '#16A34A' },
            { name: 'Red', accent: '#DC2626', soft: '#FEECEC', border: '#DC2626' },
            { name: 'Blue', accent: '#2563EB', soft: '#ECF3FF', border: '#2563EB' },
            { name: 'Teal', accent: '#449D9F', soft: '#EAF5F5', border: '#449D9F' },
            { name: 'White', accent: '#6B7280', soft: '#F7F9F9', border: '#D7E1E3' }
        ];

        this.load();
        this.initModal();
    }

    load() {
        const stored = localStorage.getItem('cnc_macros');
        if (stored) {
            try {
                this.macros = JSON.parse(stored);
                this.macros.forEach(macro => {
                    macro.color = this.normalizeColorName(macro.color);
                });
            } catch (e) {
                console.error("Failed to load macros", e);
                this.macros = [];
            }
        }
    }

    save() {
        localStorage.setItem('cnc_macros', JSON.stringify(this.macros));
        this.render();
    }

    run(index) {
        const macro = this.macros[index];
        if (!macro || !macro.gcode) return;

        this.term.writeln(`\x1b[33m[Macro] Running: ${macro.name}\x1b[0m`);

        // Split by new line and send
        const lines = macro.gcode.split('\n');
        lines.forEach(line => {
            const cmd = line.trim();
            if (cmd && !cmd.startsWith(';')) { // Skip comments and empty lines
                this.ws.sendCommand(cmd);
            }
        });
    }

    delete(index) {
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Delete Macro', 'Are you sure you want to delete this macro?', () => {
            this.macros.splice(index, 1);
            this.save();
        });
    }

    // --- UI Rendering ---

    render() {
        const container = document.getElementById('macro-grid');
        if (!container) return;

        container.innerHTML = '';

        this.macros.forEach((macro, index) => {
            const btn = document.createElement('div');
            const colorDef = this.colors.find(c => c.name === this.normalizeColorName(macro.color)) || this.colors[0];
            const preview = this.getGcodePreview(macro.gcode);

            btn.className = 'macro-card relative group cursor-pointer border-2 bg-white shadow-sm transition-all hover:shadow-md p-3 flex items-center';
            btn.style.borderColor = colorDef.border;

            btn.innerHTML = `
                <div class="flex w-full items-center gap-3 pr-16">
                    <div class="macro-card-icon shrink-0" style="background-color: ${colorDef.soft}; color: ${colorDef.accent};">
                        <i data-lucide="${this.normalizeIcon(macro.icon)}" class="text-[1.2rem]"></i>
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="macro-card-title font-bold text-lg leading-tight text-secondary select-none">${this.escapeHtml(macro.name || 'Unnamed Macro')}</div>
                        <div class="macro-card-gcode mt-1 text-sm leading-5 text-grey-dark">${this.escapeHtml(preview)}</div>
                    </div>
                </div>

                <div class="macro-card-actions">
                    <button class="edit-btn macro-card-action-btn" title="Edit" type="button" aria-label="Edit macro">
                        <i data-lucide="pencil" style="width:12px;height:12px"></i>
                    </button>
                    <button class="del-btn macro-card-action-btn" title="Delete" type="button" aria-label="Delete macro">
                        <i data-lucide="trash-2" style="width:12px;height:12px"></i>
                    </button>
                </div>
            `;

            // Click to run
            btn.addEventListener('click', (e) => {
                // Prevent running if clicking edit/delete buttons
                if (e.target.closest('.edit-btn') || e.target.closest('.del-btn')) return;
                this.run(index);
            });

            // Edit Action
            btn.querySelector('.edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.openModal(index);
            });

            // Delete Action
            btn.querySelector('.del-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.delete(index);
            });

            container.appendChild(btn);
        });

        // Add "New Macro" Button
        const addBtn = document.createElement('div');
        addBtn.className = "macro-card macro-card--add cursor-pointer border-2 border-dashed border-grey-light hover:border-primary hover:bg-white transition-colors flex items-center gap-4 p-4 text-grey hover:text-primary";
        addBtn.innerHTML = `
            <span class="macro-card-add-icon">
                <i data-lucide="plus" style="width:20px;height:20px"></i>
            </span>
            <span class="macro-card-add-label">Add Macro</span>
        `;
        addBtn.addEventListener('click', () => this.openModal(null));
        container.appendChild(addBtn);
        if (window.lucide) window.lucide.createIcons();
    }

    // --- Modal Logic ---

    initModal() {
        // Find modal elements
        this.modal = document.getElementById('macro-modal');
        this.modalController = registerModal(this.modal, { closeOnBackdrop: true, closeOnEscape: true });
        this.iconGrid = document.getElementById('macro-icon-grid');
        this.colorSelect = document.getElementById('macro-color-select');

        // Populate Icon Grid
        this.icons.forEach(iconClass => {
            const iBtn = document.createElement('button');
            iBtn.className = "w-10 h-10 flex items-center justify-center rounded border border-grey-light hover:bg-primary hover:text-black hover:border-primary transition-colors text-xl text-grey-dark icon-option";
            iBtn.innerHTML = `<i data-lucide="${iconClass}" class="w-5 h-5"></i>`;
            iBtn.dataset.icon = iconClass;
            iBtn.type = "button"; // Prevent form submit
            iBtn.addEventListener('click', () => {
                // Highlight selected
                document.querySelectorAll('.icon-option').forEach(el => el.classList.remove('bg-primary', 'text-black', 'border-primary'));
                iBtn.classList.add('bg-primary', 'text-black', 'border-primary');
                document.getElementById('macro-icon-input').value = iconClass;
                if (window.lucide) window.lucide.createIcons();
            });
            this.iconGrid.appendChild(iBtn);
        });
        if (window.lucide) window.lucide.createIcons();

        // Populate Color Select
        this.colors.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            this.colorSelect.appendChild(opt);
        });

        // Save Button
        document.getElementById('btn-save-macro').addEventListener('click', () => this.saveFromModal());

        // Close Button
        document.getElementById('btn-close-macro').addEventListener('click', () => {
            this.modalController?.hide();
        });
    }

    openModal(index) {
        this.editingId = index;
        const nameInput = document.getElementById('macro-name-input');
        const gcodeInput = document.getElementById('macro-gcode-input');
        const iconInput = document.getElementById('macro-icon-input');
        const modalTitle = document.getElementById('macro-modal-title');

        // Reset UI classes
        document.querySelectorAll('.icon-option').forEach(el => el.classList.remove('bg-primary', 'text-black', 'border-primary'));

        if (index === null) {
            // New
            modalTitle.textContent = "Create New Macro";
            nameInput.value = "";
            gcodeInput.value = "";
            iconInput.value = this.icons[0];
            this.colorSelect.value = "Orange";
            // Select first icon visually
            this.iconGrid.firstElementChild.classList.add('bg-primary', 'text-black', 'border-primary');
        } else {
            // Edit
            const m = this.macros[index];
            const normalizedIcon = this.normalizeIcon(m.icon);
            modalTitle.textContent = "Edit Macro";
            nameInput.value = m.name;
            gcodeInput.value = m.gcode;
            iconInput.value = normalizedIcon;
            this.colorSelect.value = this.normalizeColorName(m.color);

            // Highlight Icon
            const iconBtn = this.iconGrid.querySelector(`[data-icon="${normalizedIcon}"]`);
            if (iconBtn) iconBtn.classList.add('bg-primary', 'text-black', 'border-primary');
        }

        this.modalController?.show();
        if (window.lucide) window.lucide.createIcons();
    }

    normalizeIcon(icon) {
        const map = {
            'bi-play-fill': 'play',
            'bi-stop-fill': 'square',
            'bi-pause-fill': 'pause',
            'bi-house-door-fill': 'house',
            'bi-fan': 'fan',
            'bi-droplet-fill': 'droplets',
            'bi-lightning-fill': 'zap',
            'bi-tools': 'wrench',
            'bi-bullseye': 'crosshair',
            'bi-arrows-move': 'move',
            'bi-arrow-clockwise': 'rotate-cw',
            'bi-arrow-counterclockwise': 'rotate-ccw',
            'bi-lightbulb-fill': 'lightbulb',
            'bi-box-seam': 'package',
            'bi-rulers': 'ruler',
            'bi-gear-fill': 'settings',
            'bi-wind': 'wind',
            'bi-thermometer-half': 'thermometer',
            'bi-speedometer2': 'gauge',
            'bi-trash': 'trash-2'
        };
        return map[icon] || icon || 'play';
    }

    normalizeColorName(color) {
        const map = {
            Yellow: 'Orange',
            Grey: 'Teal'
        };
        return map[color] || color || 'Orange';
    }

    getGcodePreview(gcode) {
        if (!gcode) return 'No gcode configured.';

        const flattened = gcode
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .join(' ');

        if (flattened.length <= 72) return flattened;
        return `${flattened.slice(0, 69).trimEnd()}...`;
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    saveFromModal() {
        const name = document.getElementById('macro-name-input').value.trim();
        const gcode = document.getElementById('macro-gcode-input').value;
        const icon = document.getElementById('macro-icon-input').value;
        const color = this.normalizeColorName(this.colorSelect.value);

        if (!name) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
            if (reporter) {
                reporter.showAlert('Name Required', 'Macro name is required');
            }
            return;
        }

        const macroObj = { name, gcode, icon, color };

        if (this.editingId === null) {
            this.macros.push(macroObj);
        } else {
            this.macros[this.editingId] = macroObj;
        }

        this.save(); // Saves to localstorage and re-renders
        this.modalController?.hide();
    }
}
