export class TroubleshootingInfoView {
    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _infoRow(label, value, valueClass = 'text-xs font-bold text-secondary-dark text-right break-all') {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="flex justify-between gap-4">
            <span class="text-xs text-grey">${this._escapeHtml(label)}</span>
            <span class="${valueClass}">${this._escapeHtml(value)}</span>
        </div>`;
    }

    _detailBlock(title, lines, emptyMessage = 'Not available yet.') {
        const content = lines?.length ? lines.join('\n') : emptyMessage;
        return `<details class="pt-2 border-t border-grey-light/60">
            <summary class="text-[10px] font-bold text-grey uppercase cursor-pointer">${this._escapeHtml(title)}</summary>
            <pre class="mt-2 rounded-lg border border-grey-light bg-grey-bg px-3 py-2 text-[11px] leading-relaxed text-secondary-dark font-mono whitespace-pre-wrap break-words">${this._escapeHtml(content)}</pre>
        </details>`;
    }

    _getAppVersion() {
        return document.title.replace('Ooznest Control ', '') || 'Unknown';
    }

    _getFirmwareInfo() {
        const wizard = window.configWizard;
        const verInfo = wizard?.verInfo || null;
        return {
            version: verInfo?.version || 'Unknown',
            machineConfig: verInfo?.configName || 'None',
            decodedConfig: wizard?._decodeMachineConfig?.(verInfo?.configName) || null,
            board: wizard?.boardInfo || null,
            options: wizard?.optInfo ? wizard.optInfo.slice(1, -1) : null
        };
    }

    _getPowerSupplyLines() {
        const latest = window.troubleshooting?.getLatestPowerSupplyValues?.();
        if (!latest) return [];
        return [
            `Voltage: ${Number(latest.voltage).toFixed(2)} V`,
            `Current: ${Number(latest.current).toFixed(2)} A`,
            `Sampled: ${new Date(latest.t).toLocaleString()}`
        ];
    }

    _getSpindleLines() {
        const spindles = window.troubleshooting?.spindles || [];
        return spindles.map((spindle, index) => {
            const fields = [
                `${index + 1}. ${spindle.name || 'Unknown spindle'}`,
                spindle.typeLabel ? `Type: ${spindle.typeLabel}` : null,
                spindle.spindleNum ? `Spindle: ${spindle.spindleNum}` : null,
                spindle.rpmRange ? `RPM: ${spindle.rpmRange}` : null,
                spindle.caps ? `Capabilities: ${spindle.caps.replace('*', '') || 'None'}` : null,
                spindle.isActive ? 'Active' : null
            ].filter(Boolean);
            return fields.join(' | ');
        });
    }

    _getPinStateLines() {
        const trouble = window.troubleshooting;
        if (!trouble) return [];

        const lines = [];
        const append = (heading, pins, lookupA, lookupB) => {
            if (!pins.length) return;
            if (lines.length) lines.push('');
            lines.push(`[${heading}]`);
            pins.forEach(pin => {
                const pinDef = lookupA?.[pin.pin] || lookupB?.[pin.pin];
                const label = pinDef?.label || pin.name;
                const func = pinDef?.func ? ` | ${pinDef.func}` : '';
                lines.push(`P${pin.pin}: ${label} = ${pin.state}${func}`);
            });
        };

        append('Digital Inputs', trouble.pinStateDIN || [], trouble.inputDefsByPin, trouble.pinDefsByPin);
        append('Digital Outputs', trouble.pinStateDOUT || [], trouble.outputDefsByPin, trouble.pinDefsByPin);
        return lines;
    }

    _getHomingLines() {
        const trouble = window.troubleshooting;
        const hasA = trouble?.hasAAxis?.() || false;
        const axes = hasA ? ['X', 'Y', 'Z', 'A'] : ['X', 'Y', 'Z'];
        const mask = trouble?.lastHomingMask;
        return axes.map((axis, index) => {
            if (mask === null || mask === undefined) return `${axis} Axis: Unknown`;
            return `${axis} Axis: ${((mask >> index) & 1) ? 'HOMED' : 'Not homed'}`;
        });
    }

    _getBitmaskLabels(setting) {
        const intVal = parseInt(setting?.val, 10) || 0;
        if (!intVal) return [];

        let labels = [];
        if (setting.type === 4) {
            if (setting.format) {
                if (/^\d+$/.test(setting.format)) {
                    labels = ['X', 'Y', 'Z', 'A', 'B', 'C'].slice(0, parseInt(setting.format, 10));
                } else {
                    labels = setting.format.split(',').map(label => label.trim());
                }
            } else {
                labels = ['X', 'Y', 'Z', 'A', 'B', 'C'];
            }
        } else if ((setting.type === 1 || setting.type === 2 || setting.type === 'mask') && setting.format) {
            labels = setting.format.split(',').map(label => label.trim());
        }

        return labels.filter((label, index) => label && label.toUpperCase() !== 'N/A' && ((intVal & (1 << index)) !== 0));
    }

    _getGrblSettingsLines() {
        const settings = Object.values(window.grblSettings?.settings || {})
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map(setting => {
                const note = (setting.desc || setting.label || '').trim().replace(/\s+/g, ' ');
                const bitmaskLabels = this._getBitmaskLabels(setting);
                const suffix = bitmaskLabels.length ? ` (${bitmaskLabels.join(' and ')})` : '';
                return note
                    ? `$${setting.id}=${setting.val ?? ''} ; ${note}${suffix}`
                    : `$${setting.id}=${setting.val ?? ''}`;
            });
        return settings;
    }

    _getSdCardStatusLabel() {
        const isMounted = window._sdPrevMounted;
        if (isMounted === true) return 'Mounted';
        if (isMounted === false) return 'Not detected';
        return 'Unknown';
    }

    _getSdCardLines() {
        const sd = window.sdHandler;
        if (!sd) return [];

        const lines = [
            `Presence: ${this._getSdCardStatusLabel()}`,
            `Current Path: ${sd.path || '/'}`,
            `Listed Entries: ${Array.isArray(sd.listedEntries) ? sd.listedEntries.length : 0}`
        ];

        const entries = Array.isArray(sd.listedEntries) ? sd.listedEntries : [];
        if (entries.length) {
            lines.push('');
            entries.forEach(entry => {
                if (entry.type === 'dir') {
                    lines.push(`[DIR] ${entry.name}`);
                } else {
                    const size = entry.sizeDisplay || (Number.isFinite(entry.bytes) ? `${entry.bytes} bytes` : '-');
                    lines.push(`[FILE] ${entry.name} (${size})`);
                }
            });
        }

        return lines;
    }

    _getProbeConfigLines() {
        const probe = window.store?.data?.probe || {};
        const is3DProbe = !!window.probeHandler?.enable3DProbe;
        const mode = window.probeHandler?._getProbeMode ? window.probeHandler._getProbeMode(probe) : (probe.mode || 'plate');

        return [
            `Probe Mode: ${mode}`,
            `3D Probe Enabled: ${is3DProbe ? 'Yes' : 'No'}`,
            `Probe Safety Passed: ${window.probeHandler?.probeSafe ? 'Yes' : 'No'}`,
            `Tool Diameter: ${probe.toolDiameter ?? 'Unknown'}`,
            `Plate Thickness: ${probe.plateThickness ?? 'Unknown'}`,
            `XY Plate Offset: ${probe.xyPlateOffset ?? 'Unknown'}`,
            `Feed: ${probe.feed ?? 'Unknown'}`,
            `Feed Latch: ${probe.feedLatch ?? 'Unknown'}`,
            `Travel: ${probe.travel ?? 'Unknown'}`,
            `Retract: ${probe.retract ?? 'Unknown'}`,
            `Z Depth: ${probe.zDepth ?? 'Unknown'}`,
            `Plate Clearance: ${probe.plateClearance ?? 'Unknown'}`,
            `Probe Clearance: ${probe.probeClearance ?? 'Unknown'}`,
            `Feature Width: ${probe.featureW ?? 'Unknown'}`,
            `Feature Height: ${probe.featureH ?? 'Unknown'}`,
            `TLO X: ${probe.tloX ?? 'Unknown'}`,
            `TLO Y: ${probe.tloY ?? 'Unknown'}`,
            `TLO Z: ${probe.tloZ ?? 'Unknown'}`
        ];
    }

    _summarizeMacroGcode(gcode) {
        const commands = String(gcode || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith(';'));

        if (!commands.length) return 'No G-code';

        const preview = commands.slice(0, 3).join(' | ');
        return commands.length > 3 ? `${preview} | ... (${commands.length} lines)` : preview;
    }

    _getMacroLines() {
        const macros = window.macroHandler?.macros || [];
        return macros.map(macro => `${macro.name || 'Unnamed Macro'} > ${this._summarizeMacroGcode(macro.gcode)}`);
    }

    async _buildSnapshot() {
        const computer = window.troubleshooting?.getComputerInfo
            ? await window.troubleshooting.getComputerInfo()
            : null;

        return {
            exportedAt: new Date().toISOString(),
            firmware: this._getFirmwareInfo(),
            application: {
                version: this._getAppVersion(),
                platform: window.electron ? 'Desktop' : window.cordova ? 'Mobile' : 'Web'
            },
            computer,
            homing: this._getHomingLines(),
            powerSupply: this._getPowerSupplyLines(),
            sdCard: this._getSdCardLines(),
            probeConfig: this._getProbeConfigLines(),
            spindles: this._getSpindleLines(),
            pinState: this._getPinStateLines(),
            macros: this._getMacroLines(),
            grblSettings: this._getGrblSettingsLines()
        };
    }

    _snapshotSectionLines(title, lines, emptyMessage = 'Not available yet.') {
        const body = lines?.length ? lines : [emptyMessage];
        return [`=== ${title} ===`, ...body, ''];
    }

    _snapshotKeyValueLines(title, entries) {
        const lines = entries
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([label, value]) => `${label}: ${value}`);
        return this._snapshotSectionLines(title, lines);
    }

    _buildPlainTextReport(snapshot) {
        const adapterLines = snapshot.computer?.adapters?.length
            ? snapshot.computer.adapters.flatMap(adapter => [
                `${adapter.name || 'Adapter'}`,
                `  Address: ${adapter.address || 'Unknown'}`,
                `  Netmask: ${adapter.netmask || 'Unknown'}${adapter.cidr ? ` | ${adapter.cidr}` : ''}`,
                ''
            ])
            : ['No adapter details available.', ''];
        const scanRangeLines = snapshot.computer?.scanRanges?.length
            ? snapshot.computer.scanRanges.map(range => range.label || `${range.subnet}.x`)
            : [];

        const lines = [
            'OOZNEST TROUBLESHOOTING EXPORT',
            `Generated: ${new Date(snapshot.exportedAt).toLocaleString()}`,
            'Email this file to help@ooznest.co.uk and include a detailed fault description or a description of what you need help with.',
            '',
            ...this._snapshotKeyValueLines('Firmware', [
                ['Version', snapshot.firmware.version],
                ['Machine Config', snapshot.firmware.machineConfig],
                ['Decoded Config', snapshot.firmware.decodedConfig],
                ['Board', snapshot.firmware.board],
                ['Options', snapshot.firmware.options]
            ]),
            ...this._snapshotKeyValueLines('Application', [
                ['Version', snapshot.application.version],
                ['Platform', snapshot.application.platform],
                ['Exported At', snapshot.exportedAt]
            ]),
            ...this._snapshotKeyValueLines('Computer', [
                ['Runtime', snapshot.computer?.runtime],
                ['OS', snapshot.computer?.os],
                ['Browser', snapshot.computer?.browser],
                ['Language', snapshot.computer?.language],
                ['Online', snapshot.computer?.online],
                ['Screen', snapshot.computer?.screen],
                ['CPU Cores', snapshot.computer?.cores],
                ['Memory', snapshot.computer?.memory],
                ['Host', snapshot.computer?.host],
                ['Origin', snapshot.computer?.origin]
            ]),
            ...this._snapshotSectionLines('Network Adapters', adapterLines),
            ...this._snapshotSectionLines('Scanner Ranges', scanRangeLines),
            ...this._snapshotSectionLines('WebUI Environment', snapshot.computer?.userAgent ? [snapshot.computer.userAgent] : []),
            ...this._snapshotSectionLines('Homing', snapshot.homing),
            ...this._snapshotSectionLines('Power Supply', snapshot.powerSupply),
            ...this._snapshotSectionLines('SD Card', snapshot.sdCard),
            ...this._snapshotSectionLines('Probe Config', snapshot.probeConfig),
            ...this._snapshotSectionLines('Spindles', snapshot.spindles),
            ...this._snapshotSectionLines('Pin State', snapshot.pinState),
            ...this._snapshotSectionLines('Macros', snapshot.macros),
            ...this._snapshotSectionLines('Grbl Settings ($$)', snapshot.grblSettings)
        ];

        return lines.join('\n');
    }

    async _ensureJsPdfLoaded() {
        if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;

        if (!this._jspdfLoadPromise) {
            this._jspdfLoadPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
                script.onload = () => {
                    if (window.jspdf?.jsPDF) resolve(window.jspdf.jsPDF);
                    else reject(new Error('jsPDF loaded without global export'));
                };
                script.onerror = () => reject(new Error('Failed to load jsPDF'));
                document.head.appendChild(script);
            }).finally(() => {
                if (!window.jspdf?.jsPDF) this._jspdfLoadPromise = null;
            });
        }

        return this._jspdfLoadPromise;
    }

    async render() {
        const container = document.getElementById('trouble-tab-info-content');
        if (!container) return;

        const firmware = this._getFirmwareInfo();
        const computerCardHtml = window.troubleshooting?.getComputerInfo
            ? window.troubleshooting.renderComputerInfoCard(await window.troubleshooting.getComputerInfo())
            : '';
        const powerLines = this._getPowerSupplyLines();
        const sdCardLines = this._getSdCardLines();
        const probeConfigLines = this._getProbeConfigLines();
        const spindleLines = this._getSpindleLines();
        const pinStateLines = this._getPinStateLines();
        const macroLines = this._getMacroLines();
        const grblSettingsLines = this._getGrblSettingsLines();

        let html = '<div class="space-y-4">';

        html += '<div class="bg-white rounded-xl shadow-soft border border-grey-light overflow-hidden">';
        html += '<div class="px-4 py-2.5 border-b border-grey-light flex items-center gap-2">';
        html += '<h3 class="font-bold text-secondary-dark text-xs uppercase tracking-wider">Firmware</h3>';
        html += '</div><div class="p-4 space-y-2">';
        html += this._infoRow('Version', firmware.version);
        html += this._infoRow('Machine Config', firmware.machineConfig, `text-xs font-bold ${window.configWizard?._isUnconfigured?.(firmware.machineConfig) ? 'text-red-500' : 'text-secondary-dark'} text-right break-all`);
        html += firmware.decodedConfig ? `<div class="text-[10px] text-grey leading-relaxed">${this._escapeHtml(firmware.decodedConfig)}</div>` : '';
        html += this._infoRow('Board', firmware.board);
        html += this._infoRow('SD Card', this._getSdCardStatusLabel());
        if (powerLines.length >= 2) {
            html += this._infoRow('Power Supply Voltage', powerLines[0].replace('Voltage: ', ''));
            html += this._infoRow('Power Supply Current', powerLines[1].replace('Current: ', ''));
        }
        html += this._detailBlock('Spindles', spindleLines);
        html += this._detailBlock('Pin State', pinStateLines);
        html += this._detailBlock('Grbl Settings ($$)', grblSettingsLines);
        html += this._detailBlock('Power Supply Values', powerLines);
        html += this._detailBlock('SD Card', sdCardLines);
        html += this._detailBlock('Probe Config', probeConfigLines);
        html += this._detailBlock('Macros', macroLines);
        html += '</div></div>';

        html += '<div class="bg-white rounded-xl shadow-soft border border-grey-light overflow-hidden">';
        html += '<div class="px-4 py-2.5 border-b border-grey-light flex items-center gap-2">';
        html += '<h3 class="font-bold text-secondary-dark text-xs uppercase tracking-wider">Application</h3>';
        html += '</div><div class="p-4 space-y-2">';
        html += this._infoRow('Version', this._getAppVersion());
        html += this._infoRow('Platform', window.electron ? 'Desktop' : window.cordova ? 'Mobile' : 'Web');
        html += '</div></div>';

        html += computerCardHtml;

        if (firmware.options) {
            html += '<div class="bg-white rounded-xl shadow-soft border border-grey-light overflow-hidden">';
            html += '<div class="px-4 py-2.5 border-b border-grey-light flex items-center gap-2">';
            html += '<h3 class="font-bold text-secondary-dark text-xs uppercase tracking-wider">Options</h3>';
            html += `</div><div class="p-4"><span class="text-xs text-grey">${this._escapeHtml(firmware.options)}</span></div></div>`;
        }

        if (window.configWizard?.verInfo && window.configWizard._isUnconfigured(window.configWizard.verInfo.configName)) {
            html += '<button onclick="window.configWizard.showWizard()" class="btn btn-primary w-full">Run Configuration Wizard</button>';
        }

        html += '</div>';
        container.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
    }

    async exportHtml() {
        if (!window.ws || !window.ws.isConnected) {
            window.showToast?.('Exporting without a machine connection. PC info will be included, but connect to capture full machine details.', 'plug-zap', 'warning');
        }

        const snapshot = await this._buildSnapshot();
        const exportDate = new Date(snapshot.exportedAt);
        const section = (title, body) => `<section class="card"><h2>${this._escapeHtml(title)}</h2>${body}</section>`;
        const row = (label, value) => value === null || value === undefined || value === ''
            ? ''
            : `<div class="row"><div class="label">${this._escapeHtml(label)}</div><div class="value">${this._escapeHtml(value)}</div></div>`;
        const rows = items => `<div class="kv">${items.filter(Boolean).join('')}</div>`;
        const pre = lines => `<pre>${this._escapeHtml(lines?.length ? lines.join('\n') : 'Not available yet.')}</pre>`;
        const adapters = snapshot.computer?.adapters?.length
            ? snapshot.computer.adapters.map(adapter => `<div class="subcard">
                <div><strong>${this._escapeHtml(adapter.name || 'Adapter')}</strong></div>
                <div>${this._escapeHtml(adapter.address || '')}</div>
                <div>${this._escapeHtml(adapter.netmask || 'Unknown')}${adapter.cidr ? ` | ${this._escapeHtml(adapter.cidr)}` : ''}</div>
            </div>`).join('')
            : '<p class="muted">No adapter details available.</p>';
        const scanRanges = snapshot.computer?.scanRanges?.length
            ? snapshot.computer.scanRanges.map(range => range.label || `${range.subnet}.x`)
            : [];

        const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ooznest Troubleshooting Export</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
    :root {
        color-scheme: light;
        --oz-primary: #FF6600;
        --oz-primary-light: #FF8533;
        --oz-primary-dark: #D55700;
        --oz-teal-brand: #004C5B;
        --oz-teal-mid: #449D9F;
        --oz-teal-light: #B0CACF;
        --oz-teal-xlight: #EBEFEF;
        --oz-secondary-dark: var(--oz-teal-brand);
        --oz-grey-dark: #2F373C;
        --oz-grey-mid: #6B7280;
        --oz-grey-light: #EBEFEF;
        --oz-white: #FFFFFF;
        --oz-bg-panel: #F7F9F9;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: "Roboto", "Inter", sans-serif;
        background: var(--oz-grey-light);
        color: var(--oz-grey-dark);
        -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 18px 48px; }
    .hero {
        background: var(--oz-white);
        color: var(--oz-grey-dark);
        border-radius: 12px;
        padding: 26px 30px;
        border: 1px solid rgba(68, 157, 159, 0.16);
    }
    .hero h1 {
        margin: 0 0 8px;
        font-family: "Nunito", "Inter", sans-serif;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: var(--oz-secondary-dark);
    }
    .hero p {
        margin: 0;
        color: var(--oz-grey-mid);
        font-size: 14px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin-top: 22px; }
    .full-width { margin-top: 18px; }
    .card {
        background: var(--oz-white);
        border: 1px solid rgba(68, 157, 159, 0.16);
        border-radius: 12px;
        padding: 20px;
    }
    .card h2 {
        margin: 0 0 14px;
        font-family: "Nunito", "Inter", sans-serif;
        font-size: 13px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--oz-secondary-dark);
    }
    .kv { display: grid; gap: 10px; }
    .row { display: grid; grid-template-columns: 155px 1fr; gap: 12px; align-items: start; padding-bottom: 10px; border-bottom: 1px solid rgba(68, 157, 159, 0.12); }
    .row:last-child { border-bottom: 0; padding-bottom: 0; }
    .label {
        font-size: 11px;
        color: var(--oz-grey-mid);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-family: "Nunito", "Inter", sans-serif;
        font-weight: 700;
    }
    .value {
        font-weight: 700;
        color: var(--oz-secondary-dark);
        word-break: break-word;
    }
    .subcard {
        background: var(--oz-bg-panel);
        border: 1px solid rgba(68, 157, 159, 0.14);
        border-radius: 8px;
        padding: 12px 14px;
        margin-bottom: 10px;
    }
    .subcard:last-child { margin-bottom: 0; }
    .subcard strong {
        font-family: "Nunito", "Inter", sans-serif;
        color: var(--oz-secondary-dark);
    }
    .muted { margin: 0; color: var(--oz-grey-mid); }
    pre {
        margin: 0;
        background: var(--oz-bg-panel);
        border: 1px solid rgba(68, 157, 159, 0.14);
        border-radius: 8px;
        padding: 14px;
        font: 12px/1.65 "Roboto Mono", "Consolas", monospace;
        color: var(--oz-grey-dark);
        white-space: pre-wrap;
        word-break: break-word;
    }
    @media (max-width: 640px) {
        .hero h1 { font-size: 22px; }
        .row { grid-template-columns: 1fr; gap: 4px; }
    }
</style>
</head>
<body>
    <div class="wrap">
        <div class="hero">
            <h1>Ooznest Troubleshooting Export</h1>
            <p>Generated ${this._escapeHtml(exportDate.toLocaleString())} for support review.</p>
            <p>Email this file to help@ooznest.co.uk and include a detailed fault description or a description of what you need help with.</p>
        </div>
        <div class="grid">
            ${section('Firmware', rows([
                row('Version', snapshot.firmware.version),
                row('Machine Config', snapshot.firmware.machineConfig),
                row('Decoded Config', snapshot.firmware.decodedConfig),
                row('Board', snapshot.firmware.board),
                row('SD Card', this._getSdCardStatusLabel()),
                row('Options', snapshot.firmware.options)
            ]))}
            ${section('Application', rows([
                row('Version', snapshot.application.version),
                row('Platform', snapshot.application.platform),
                row('Exported At', snapshot.exportedAt)
            ]))}
            ${section('Computer', rows([
                row('Runtime', snapshot.computer?.runtime),
                row('OS', snapshot.computer?.os),
                row('Browser', snapshot.computer?.browser),
                row('Language', snapshot.computer?.language),
                row('Online', snapshot.computer?.online),
                row('Screen', snapshot.computer?.screen),
                row('CPU Cores', snapshot.computer?.cores),
                row('Memory', snapshot.computer?.memory),
                row('Host', snapshot.computer?.host),
                row('Origin', snapshot.computer?.origin)
            ]))}
            ${section('Network Adapters', adapters)}
            ${section('Scanner Ranges', pre(scanRanges))}
            ${section('WebUI Environment', pre(snapshot.computer?.userAgent ? [snapshot.computer.userAgent] : []))}
            ${section('Homing', pre(snapshot.homing))}
            ${section('Power Supply', pre(snapshot.powerSupply))}
            ${section('SD Card', pre(snapshot.sdCard))}
            ${section('Probe Config', pre(snapshot.probeConfig))}
            ${section('Spindles', pre(snapshot.spindles))}
            ${section('Pin State', pre(snapshot.pinState))}
            ${section('Macros', pre(snapshot.macros))}
        </div>
        <div class="full-width">
            ${section('Grbl Settings ($$)', pre(snapshot.grblSettings))}
        </div>
    </div>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const stamp = exportDate.toISOString().replace(/[:.]/g, '-');
        const link = document.createElement('a');
        link.href = url;
        link.download = `ooznest-troubleshooting-${stamp}.html`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async exportPdf() {
        if (!window.ws || !window.ws.isConnected) {
            window.showToast?.('Exporting without a machine connection. PC info will be included, but connect to capture full machine details.', 'plug-zap', 'warning');
        }

        try {
            const jsPDF = await this._ensureJsPdfLoaded();
            const snapshot = await this._buildSnapshot();
            const reportText = this._buildPlainTextReport(snapshot);
            const exportDate = new Date(snapshot.exportedAt);
            const stamp = exportDate.toISOString().replace(/[:.]/g, '-');
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'pt',
                format: 'a4',
                compress: true
            });

            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const margin = 36;
            const maxWidth = pageWidth - (margin * 2);
            const lineHeight = 12;
            let y = margin;

            doc.setFont('courier', 'normal');
            doc.setFontSize(10);

            const lines = doc.splitTextToSize(reportText, maxWidth);
            lines.forEach(line => {
                if (y > pageHeight - margin) {
                    doc.addPage();
                    y = margin;
                }
                doc.text(line, margin, y);
                y += lineHeight;
            });

            doc.save(`ooznest-troubleshooting-${stamp}.pdf`);
        } catch (error) {
            console.error('Failed to export troubleshooting PDF:', error);
            window.showToast?.('Failed to export PDF. Please try again while online.', 'file-warning', 'error');
        }
    }
}
