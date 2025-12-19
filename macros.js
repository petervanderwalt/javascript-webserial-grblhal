export class MacroHandler {
    constructor(ws, term) {
        this.ws = ws;
        this.term = term;
        this.macros = [];
        this.editingId = null; // null = new, number = editing index

        // Predefined list of useful Bootstrap Icons for CNC
        this.icons = [
            'bi-play-fill', 'bi-stop-fill', 'bi-pause-fill', 'bi-house-door-fill',
            'bi-fan', 'bi-droplet-fill', 'bi-lightning-fill', 'bi-tools',
            'bi-bullseye', 'bi-arrows-move', 'bi-arrow-clockwise', 'bi-arrow-counterclockwise',
            'bi-lightbulb-fill', 'bi-box-seam', 'bi-rulers', 'bi-gear-fill',
            'bi-wind', 'bi-thermometer-half', 'bi-speedometer2', 'bi-trash'
        ];

        // Color options (Tailwind classes)
        this.colors = [
            { name: 'Yellow', bg: 'bg-primary', text: 'text-black', border: 'border-primary-dark' },
            { name: 'Green', bg: 'bg-green-500', text: 'text-white', border: 'border-green-600' },
            { name: 'Red', bg: 'bg-red-500', text: 'text-white', border: 'border-red-600' },
            { name: 'Blue', bg: 'bg-blue-500', text: 'text-white', border: 'border-blue-600' },
            { name: 'Grey', bg: 'bg-secondary', text: 'text-white', border: 'border-secondary-dark' },
            { name: 'White', bg: 'bg-white', text: 'text-grey-dark', border: 'border-grey-light' }
        ];

        this.load();
        this.initModal();
    }

    load() {
        const stored = localStorage.getItem('cnc_macros');
        if (stored) {
            try {
                this.macros = JSON.parse(stored);
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
            if(cmd && !cmd.startsWith(';')) { // Skip comments and empty lines
                this.ws.sendCommand(cmd);
            }
        });
    }

    delete(index) {
        if(confirm('Are you sure you want to delete this macro?')) {
            this.macros.splice(index, 1);
            this.save();
        }
    }

    // --- UI Rendering ---

    render() {
        const container = document.getElementById('macro-grid');
        if (!container) return;

        container.innerHTML = '';

        this.macros.forEach((macro, index) => {
            const btn = document.createElement('div');
            // Find color definition
            const colorDef = this.colors.find(c => c.name === macro.color) || this.colors[0];

            btn.className = `relative group cursor-pointer rounded-xl shadow-sm border-b-4 active:border-b-0 active:translate-y-1 transition-all flex flex-col items-center justify-center p-4 h-32 ${colorDef.bg} ${colorDef.text} ${colorDef.border}`;

            btn.innerHTML = `
                <i class="bi ${macro.icon} text-3xl mb-2"></i>
                <span class="font-bold text-sm text-center leading-tight select-none">${macro.name}</span>

                <!-- Hover Edit Controls -->
                <div class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                    <button class="edit-btn p-1 bg-black/20 hover:bg-black/40 rounded text-white text-xs" title="Edit">
                        <i class="bi bi-pencil-fill"></i>
                    </button>
                    <button class="del-btn p-1 bg-black/20 hover:bg-red-600 rounded text-white text-xs" title="Delete">
                        <i class="bi bi-trash-fill"></i>
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
        addBtn.className = "cursor-pointer rounded-xl border-2 border-dashed border-grey-light hover:border-primary hover:bg-white transition-colors flex flex-col items-center justify-center p-4 h-32 text-grey hover:text-primary";
        addBtn.innerHTML = `
            <i class="bi bi-plus-lg text-4xl mb-1"></i>
            <span class="font-bold text-xs uppercase tracking-wider">Add Macro</span>
        `;
        addBtn.addEventListener('click', () => this.openModal(null));
        container.appendChild(addBtn);
    }

    // --- Modal Logic ---

    initModal() {
        // Find modal elements
        this.modal = document.getElementById('macro-modal');
        this.iconGrid = document.getElementById('macro-icon-grid');
        this.colorSelect = document.getElementById('macro-color-select');

        // Populate Icon Grid
        this.icons.forEach(iconClass => {
            const iBtn = document.createElement('button');
            iBtn.className = "w-10 h-10 flex items-center justify-center rounded border border-grey-light hover:bg-primary hover:text-black hover:border-primary transition-colors text-xl text-grey-dark icon-option";
            iBtn.innerHTML = `<i class="bi ${iconClass}"></i>`;
            iBtn.dataset.icon = iconClass;
            iBtn.type = "button"; // Prevent form submit
            iBtn.addEventListener('click', () => {
                // Highlight selected
                document.querySelectorAll('.icon-option').forEach(el => el.classList.remove('bg-primary', 'text-black', 'border-primary'));
                iBtn.classList.add('bg-primary', 'text-black', 'border-primary');
                document.getElementById('macro-icon-input').value = iconClass;
            });
            this.iconGrid.appendChild(iBtn);
        });

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
            this.modal.classList.add('hidden');
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
            this.colorSelect.value = "Yellow";
            // Select first icon visually
            this.iconGrid.firstElementChild.classList.add('bg-primary', 'text-black', 'border-primary');
        } else {
            // Edit
            const m = this.macros[index];
            modalTitle.textContent = "Edit Macro";
            nameInput.value = m.name;
            gcodeInput.value = m.gcode;
            iconInput.value = m.icon;
            this.colorSelect.value = m.color;

            // Highlight Icon
            const iconBtn = this.iconGrid.querySelector(`[data-icon="${m.icon}"]`);
            if (iconBtn) iconBtn.classList.add('bg-primary', 'text-black', 'border-primary');
        }

        this.modal.classList.remove('hidden');
    }

    saveFromModal() {
        const name = document.getElementById('macro-name-input').value.trim();
        const gcode = document.getElementById('macro-gcode-input').value;
        const icon = document.getElementById('macro-icon-input').value;
        const color = this.colorSelect.value;

        if (!name) {
            alert("Macro name is required");
            return;
        }

        const macroObj = { name, gcode, icon, color };

        if (this.editingId === null) {
            this.macros.push(macroObj);
        } else {
            this.macros[this.editingId] = macroObj;
        }

        this.save(); // Saves to localstorage and re-renders
        this.modal.classList.add('hidden');
    }
}
