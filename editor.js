export class GCodeEditor {
    constructor(containerId, themeColors) {
        this.container = document.getElementById(containerId);
        this.lines = []; // Stores the raw string lines
        this.lineHeight = 21; // Pixels per line (must match CSS)
        this.visibleLines = 0;
        this.scrollTop = 0;

        // Theme config
        this.colors = themeColors || {
            bg: '#ffffff',
            text: '#333333',
            lineNumBg: '#f8f9fa',
            lineNumText: '#909090',
            cursor: '#E6F4F5',
            // Syntax
            comment: '#909090',
            command: '#000000', // G0, G1
            coord: '#d97706',   // X, Y, Z
            val: '#2563eb'      // Numbers
        };

        this.initDOM();
        this.bindEvents();
    }

    initDOM() {
        this.container.classList.add('overflow-y-auto', 'bg-white', 'font-mono', 'text-sm', 'outline-none');
        // Removed 'contain: strict' to prevent rendering artifacts during scroll/focus interaction

        // The "phantom" element to force the scrollbar to the correct height
        this.phantom = document.createElement('div');
        this.phantom.style.width = '1px';
        this.phantom.style.height = '0px';
        this.container.appendChild(this.phantom);

        // The content container that moves with scroll
        this.contentLayer = document.createElement('div');
        this.contentLayer.style.position = 'absolute';
        this.contentLayer.style.top = '0';
        this.contentLayer.style.left = '0';
        this.contentLayer.style.right = '0';
        this.container.appendChild(this.contentLayer);
    }

    bindEvents() {
        this.container.addEventListener('scroll', (e) => {
            this.scrollTop = e.target.scrollTop;
            requestAnimationFrame(() => this.renderVisible());
        });

        // Handle window resize to adjust number of visible lines
        window.addEventListener('resize', () => this.resize());

        // Refresh when tab becomes visible
        window.addEventListener('tab-shown', (e) => {
            if (e.detail.id === 'editor-view') {
                setTimeout(() => {
                    this.resize();
                    this.renderVisible();
                }, 10);
            }
        });
    }

    // Load content (splits by newline)
    setValue(text) {
        if(!text) {
            this.lines = [];
        } else {
            // Split by newline, handle CR/LF
            this.lines = text.split(/\r\n|\r|\n/);
        }

        this.phantom.style.height = `${this.lines.length * this.lineHeight}px`;

        // Reset state
        this.scrollTop = 0;
        this.container.scrollTop = 0;

        // Try to render immediately (if visible), otherwise tab-shown will catch it
        this.resize();
    }

    // Get current content (joins by newline)
    getValue() {
        return this.lines.join('\n');
    }

    resize() {
        const h = this.container.clientHeight;
        if (h > 0) {
            // Calculate how many lines fit in the view + buffer
            this.visibleLines = Math.ceil(h / this.lineHeight) + 2;
            this.renderVisible();
        }
    }

    // Update a specific line (e.g. from user edit)
    updateLine(index, newText) {
        if (index >= 0 && index < this.lines.length) {
            this.lines[index] = newText;
        }
    }

    // The Magic: Only render what is seen
    renderVisible() {
        if (this.lines.length === 0) {
            this.contentLayer.innerHTML = '<div class="p-4 text-gray-400 italic">No file loaded.</div>';
            return;
        }

        // Calculate start index based on scroll position
        const startNode = Math.floor(this.scrollTop / this.lineHeight);
        const endNode = Math.min(this.lines.length, startNode + this.visibleLines);

        // Offset the content layer so it stays in view
        const offsetY = startNode * this.lineHeight;
        this.contentLayer.style.transform = `translateY(${offsetY}px)`;

        let html = '';

        for (let i = startNode; i < endNode; i++) {
            const lineContent = this.highlight(this.lines[i]);
            // Row HTML - CHANGED:
            // 1. Removed 'flex items-center' from contenteditable div (Fixes cursor artifacts)
            // 2. Added 'leading-[21px]' to center text vertically via line-height
            // 3. Added 'onkeydown' to block Enter key
            html += `<div class="flex h-[21px] w-full border-b border-gray-100 hover:bg-blue-50 group" data-idx="${i}">
                <div class="w-12 shrink-0 bg-gray-50 text-gray-400 text-right pr-2 select-none border-r border-gray-200 text-xs flex items-center justify-end font-mono">${i + 1}</div>
                <div class="flex-1 whitespace-pre pl-2 font-mono text-[13px] leading-[21px] text-gray-800 outline-none block" contenteditable="true" spellcheck="false" onblur="window.editor.handleBlur(this, ${i})" onkeydown="window.editor.handleKeyDown(event)">${lineContent}</div>
            </div>`;
        }

        this.contentLayer.innerHTML = html;
    }

    // Extremely simple syntax highlighter (RegEx)
    highlight(text) {
        if (!text) return '';

        // 1. Comments (make them grey and return early)
        if (text.trim().startsWith(';') || text.trim().startsWith('(')) {
            return `<span style="color:${this.colors.comment}">${this.escapeHtml(text)}</span>`;
        }

        let res = this.escapeHtml(text);

        // 2. G/M Codes (Bold Black)
        res = res.replace(/([GM])(\d+(\.\d+)?)/gi, `<span style="font-weight:800; color:${this.colors.command}">$1$2</span>`);

        // 3. Axis Letters (Orange)
        res = res.replace(/([XYZIJKR])(?=[\d\.-])/gi, `<span style="font-weight:bold; color:${this.colors.coord}">$1</span>`);

        // 4. Feed/Speed (Green)
        res = res.replace(/([FS])(\d+(\.\d+)?)/gi, `<span style="font-weight:bold; color:#059669">$1$2</span>`);

        return res;
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Called when a line loses focus after editing
    handleBlur(el, index) {
        // CHANGED: Use textContent to avoid artifacts and newlines from innerText
        let newText = el.textContent;
        // Clean any accidental newlines that might have been pasted
        newText = newText.replace(/(\r\n|\n|\r)/gm, "");

        this.updateLine(index, newText);
        // Re-render to apply syntax highlighting
        el.innerHTML = this.highlight(newText);
    }

    // Prevent Enter key (single line editing only)
    handleKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
        }
    }
}
