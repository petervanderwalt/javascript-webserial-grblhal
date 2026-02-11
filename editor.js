export class GCodeEditor {
    constructor(containerId, themeColors) {
        this.container = document.getElementById(containerId);

        // Create textarea
        this.textarea = document.createElement('textarea');
        this.textarea.className = 'w-full h-full p-4 font-mono text-sm resize-none outline-none border-0';
        this.textarea.style.fontFamily = 'JetBrains Mono, monospace';
        this.textarea.style.fontSize = '13px';
        this.textarea.style.lineHeight = '1.6';
        this.textarea.style.tabSize = '4';
        this.textarea.spellcheck = false;
        this.textarea.placeholder = 'Load a G-code file or start typing...';

        // Clear container and add textarea
        this.container.innerHTML = '';
        this.container.appendChild(this.textarea);

        // Handle tab key
        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = this.textarea.selectionStart;
                const end = this.textarea.selectionEnd;
                const value = this.textarea.value;

                // Insert tab
                this.textarea.value = value.substring(0, start) + '\t' + value.substring(end);
                this.textarea.selectionStart = this.textarea.selectionEnd = start + 1;
            }
        });
    }

    // Load content
    setValue(text) {
        this.textarea.value = text || '';
    }

    // Get current content
    getValue() {
        return this.textarea.value;
    }

    // No-op methods for compatibility
    resize() { }
    updateLine(index, newText) { }
    handleBlur(el, index) { }
    handleKeyDown(e) { }
}
