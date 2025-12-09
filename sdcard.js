const SOH=0x01, STX=0x02, EOT=0x04, ACK=0x06, NAK=0x15, CAN=0x18, C_CHAR=0x43;
export class SDCardHandler {
constructor(ws, term, viewer, callbacks) {
  this.ws = ws;
  this.term = term;
  this.viewer = viewer;

  // Callbacks: { onDownloadComplete(content), pausePolling(), resumePolling(), switchToViewer() }
      this.callbacks = callbacks;

      this.path = "/";
      this.fileCount = 0;

      // Download State
      this.isDownloading = false;
      this.downloadBuffer = "";
      this.downloadTimeout = null;
      this.downloadLineCount = 0;

      // YMODEM State
      this.ymodem = {
          active: false,
          state: 0,
          fileBytes: null,
          fileName: "",
          fileSize: 0,
          packetNum: 0,
          offset: 0
      };
  }

  /**
   * Main handler for incoming serial lines.
   * Returns true if the line was consumed by SD logic.
   */
   processLine(line) {
     // 1. Download Mode
     if (this.isDownloading) {
         // --- NEW LOGIC ---
         // The 'ok' signals the end of the stream. When we see it, and we have
         // already received data, we can finalize the download immediately.
         if (line.trim() === 'ok' && this.downloadBuffer.length > 0) {
             if (this.downloadTimeout) clearTimeout(this.downloadTimeout); // Clean up the timer
             this._finishDownload(); // Finalize immediately
             return true; // Consume the 'ok' line and stop processing
         }
         // --- END NEW LOGIC ---

         // This handles an edge case where an 'ok' might be the very first response.
         if (line === 'ok' && this.downloadBuffer.length === 0) return true;

         // Add the current line to our buffer
         this.downloadBuffer += line + "\n";
         this.downloadLineCount++;

         // Reset the timeout. It now acts as a safety net in case the 'ok' never arrives.
         if (this.downloadTimeout) clearTimeout(this.downloadTimeout);
         this.downloadTimeout = setTimeout(() => {
             console.warn("Download finished due to timeout. The 'ok' confirmation was not received.");
             this._finishDownload();
         }, 1000); // Increased timeout to 1 sec for safety.

         if (this.downloadLineCount % 100 === 0) {
             this.term.writeln(`\x1b[33mDownloading... (${this.downloadLineCount} lines)\x1b[0m`);
         }
         return true;
     }

     // 2. File Listing
     if (line.startsWith('[FILE:')) {
         this._addSdFile(line);
         return true;
     }
     if (line.startsWith('[DIR:')) {
         this._addSdDir(line);
         return true;
     }

     return false;
 }

  // --- Actions ---

  refresh() {
      document.querySelector('#sd-table tbody').innerHTML = '';
      document.getElementById('sd-current-path').textContent = this.path;
      this.fileCount = 0;
      document.getElementById('sd-badge').classList.add('hidden');
      this.ws.sendCommand('$F+');
  }

  upLevel() {
      if (this.path === "/") return;
      const p = this.path.split('/');
      p.pop();
      this.path = p.join('/') || "/";
      this.refresh();
  }

  enterDir(dirName) {
      this.path = this.path === "/" ? `/${dirName}` : `${this.path}/${dirName}`;
      this.refresh();
  }

  delete(fileName) {
      if (confirm(`Delete ${fileName}?`)) {
          const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;
          this.ws.sendCommand(`$FD=${fullPath}`);
          // Small delay to allow delete to process
          setTimeout(() => this.refresh(), 1000);
      }
  }

  async preview(fileName) {
      if (this.isDownloading) return;
      if (!confirm(`Download ${fileName}?`)) return;

      this.isDownloading = true;
      this.downloadBuffer = "";
      this.downloadLineCount = 0;

      const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;
      this.term.writeln(`\x1b[33mDownloading ${fullPath}...\x1b[0m`);
      await this.ws.sendCommand(`$F<=${fullPath}`);
  }

  runFile(fileName) {
      const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;
      // Usually running a file directly from SD on Grbl is done via $F=
      this.ws.sendCommand(`$F=${fullPath}`);
  }

  /**
   * Executes a specific G65 Macro
   * @param {string} pNum - The macro number (e.g., "100" for P100.macro)
   */
  runMacro(pNum) {
      this.ws.sendCommand(`G65 P${pNum}`);
      this.term.writeln(`\x1b[36m> Executing Macro: P${pNum}\x1b[0m`);
  }

  // --- Internal Parsing ---

  _addSdFile(line) {
      const content = line.replace('[FILE:', '').replace(']', '').split('|');
      const fullPath = content[0];
      const name = fullPath.split('/').pop();

      // Parse Size
      const sizePart = content.find(p => p.startsWith('SIZE:'));
      let sizeDisplay = '-';
      if (sizePart) {
          const bytes = parseInt(sizePart.split(':')[1]);
          sizeDisplay = this._formatBytes(bytes);
      }

      // Update Badge
      this.fileCount++;
      const badge = document.getElementById('sd-badge');
      badge.textContent = this.fileCount;
      badge.classList.remove('hidden');

      // Check for Macro Pattern (P<digits>.macro)
      const macroMatch = name.match(/^P(\d+)\.macro$/i);
      let runActionBtn = '';

      // Fixed width buttons for alignment
      if (macroMatch) {
          const pNum = macroMatch[1];
          // Grey button for Macros, Width 36
          runActionBtn = `<button class="btn-ghost w-36 flex items-center justify-end gap-2 text-grey-dark hover:text-black" onclick="window.sdHandler.runMacro('${pNum}')" title="Run macro"><i class="bi bi-gear-wide-connected"></i> Run macro</button>`;
      } else {
          // Green button for normal G-code, Width 36
          runActionBtn = `<button class="btn-ghost w-36 flex items-center justify-end gap-2 text-green-600 hover:text-green-800" onclick="window.sdHandler.runFile('${name}')" title="Run"><i class="bi bi-play-fill"></i> Run File</button>`;
      }

      // Create HTML Row
      const row = `
          <tr class="hover:bg-grey-light/30 border-b border-grey-light last:border-b-0 transition-colors">
              <td class="px-6 py-3 font-medium text-grey-dark flex items-center gap-2">
                  <i class="bi bi-file-earmark-code text-grey"></i>${name}
              </td>
              <td class="px-6 py-3 text-grey font-mono text-xs">${sizeDisplay}</td>
              <td class="px-6 py-3 text-right">
                  <div class="flex justify-end gap-2">
                      <button class="btn-ghost w-24 flex items-center justify-end gap-2" onclick="window.sdHandler.delete('${name}')" title="Delete"><i class="bi bi-trash"></i> Delete</button>
                      <button class="btn-ghost w-24 flex items-center justify-end gap-2" onclick="window.sdHandler.preview('${name}')" title="Preview"><i class="bi bi-eye"></i> Preview</button>
                      ${runActionBtn}
                  </div>
              </td>
          </tr>`;

      document.querySelector('#sd-table tbody').insertAdjacentHTML('beforeend', row);
  }

  _formatBytes(bytes, decimals = 2) {
      if (!+bytes) return '0 Bytes';

      const k = 1024;
      const dm = decimals < 0 ? 0 : decimals;
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

      const i = Math.floor(Math.log(bytes) / Math.log(k));

      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  _addSdDir(line) {
      const content = line.replace('[DIR:', '').replace(']', '');
      const name = content.split('/').pop();
      const tbody = document.querySelector('#sd-table tbody');

      const row = document.createElement('tr');
      row.className = "hover:bg-grey-light/30 border-b border-grey-light cursor-pointer transition-colors";
      row.onclick = (e) => {
          // Prevent triggering when clicking buttons
          if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I') {
              this.enterDir(name);
          }
      };

      row.innerHTML = `
          <td class="px-6 py-3 font-bold text-grey-dark flex items-center gap-2">
              <i class="bi bi-folder-fill text-primary/70 mr-2"></i>${name}
          </td>
          <td class="px-6 py-3 text-grey text-xs">-</td>
          <td class="px-6 py-3 text-right">
              <div class="flex justify-end">
                  <button class="btn btn-secondary text-xs py-1 px-3" onclick="window.sdHandler.enterDir('${name}')">Open</button>
              </div>
          </td>`;

      // Insert directories at the top
      tbody.insertBefore(row, tbody.firstChild);
  }

  _finishDownload() {
    console.log("finishDownload")
      this.isDownloading = false;
      if (this.downloadTimeout) clearTimeout(this.downloadTimeout);

      // Strip Grbl response codes from file content if necessary (usually they are clean or need simple cleaning)
      // Here assuming raw G-code + 'ok' lines occasionally mixed in stream if not careful,
      // but $F< dumps pure content usually.
      // Simple cleanup: remove <...> status reports if they snuck in

      const cleanContent = this.downloadBuffer.replace(/<.*>/g, '').trim();
      const lines = cleanContent.split('\n').filter(l => l.trim().length > 0 && l.trim() !== 'ok');


      if (lines.length === 0) {
          this.term.writeln(`\x1b[31mDownload Failed: No data.\x1b[0m`);
      } else {
          this.term.writeln(`\x1b[32mDownloaded ${lines.length} lines.\x1b[0m`);

          // Invoke callback to update main app state
          if (this.callbacks.onDownloadComplete) {
              this.callbacks.onDownloadComplete(cleanContent);
          }

          // Update 3D viewer
          this.viewer.processGCodeString(cleanContent);

          if (this.callbacks.switchToViewer) {
              this.callbacks.switchToViewer();
          }
      }
  }

  // --- YMODEM Upload ---

  async startUpload(file) {
      if (!file) return;

      // Sanitize filename
      const name = file.name.replace(/\s/g, '_');

      if (!confirm(`Upload ${name} (${this._formatBytes(file.size)})?`)) return;

      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);

      // Pause status polling
      if (this.callbacks.pausePolling) this.callbacks.pausePolling();

      // Hijack serial input
      this.ws.setRawHandler((data) => this._handleYmodemInput(data));

      this.ymodem = {
          active: true,
          state: 1,
          fileBytes: bytes,
          fileName: name,
          fileSize: bytes.length,
          packetNum: 0,
          offset: 0
      };

      // UI Updates
      document.getElementById('upload-progress-container').style.display = 'block';
      document.getElementById('upload-progress-bar').style.width = '0%';
      this.term.writeln('\x1b[35m[YMODEM] Start...\x1b[0m');

      // Initiate upload command
      const fp = this.path === '/' ? name : `${this.path}/${name}`;
      await this.ws.writeRaw(new TextEncoder().encode(`$FY=${fp}\n`));
  }

  _handleYmodemInput(data) {
      for (let i = 0; i < data.length; i++) {
          this._processYmodemByte(data[i]);
      }
  }

  async _processYmodemByte(b) {
      const y = this.ymodem;

      if (y.state === 1) {
          // Wait for 'C' to start filename packet
          if (b === C_CHAR) {
              await this._sendPacket0();
              y.state = 2;
          }
      }
      else if (y.state === 2) {
          // Wait for ACK then 'C' for data
          if (b === C_CHAR) {
              y.packetNum = 1;
              await this._sendNextDataPacket();
              y.state = 3;
          }
      }
      else if (y.state === 3) {
          // Sending Data
          if (b === ACK) {
              y.offset += 1024;
              const pct = Math.round((y.offset / y.fileSize) * 100);
              document.getElementById('upload-progress-bar').style.width = `${pct}%`;
              document.getElementById('upload-pct').textContent = `${pct}%`;

              if (y.offset < y.fileSize) {
                  y.packetNum++;
                  await this._sendNextDataPacket();
              } else {
                  await this.ws.writeRaw(new Uint8Array([EOT]));
                  y.state = 4;
              }
          } else if (b === NAK) {
              await this._sendNextDataPacket(); // Retry
          } else if (b === CAN) {
              this._abortYmodem('Cancelled');
          }
      }
      else if (y.state === 4) {
          // EOT Handshake
          if (b === NAK) {
              await this.ws.writeRaw(new Uint8Array([EOT]));
          } else if (b === ACK) {
              y.state = 5;
          }
      }
      else if (y.state === 5) {
          // Wait for 'C' to send null packet (end)
          if (b === C_CHAR) {
              await this._sendNullPacket();
              y.state = 6;
          }
      }
      else if (y.state === 6) {
          // Final ACK
          if (b === ACK) {
              this._finishYmodem();
          }
      }
  }

  async _sendPacket0() {
      const nameEnc = new TextEncoder().encode(this.ymodem.fileName);
      const sizeEnc = new TextEncoder().encode(this.ymodem.fileSize.toString());
      const packet = new Uint8Array(128);
      packet.fill(0);
      packet.set(nameEnc, 0);
      // Null terminator implicitly at packet[nameEnc.length] because of fill(0)
      packet.set(sizeEnc, nameEnc.length + 1);
      await this._sendPacket(0, packet);
  }

  async _sendNextDataPacket() {
      const remaining = this.ymodem.fileSize - this.ymodem.offset;
      const packet = new Uint8Array(1024);
      packet.fill(0x1A); // padding
      const chunk = this.ymodem.fileBytes.subarray(this.ymodem.offset, this.ymodem.offset + Math.min(remaining, 1024));
      packet.set(chunk, 0);
      await this._sendPacket(this.ymodem.packetNum & 0xFF, packet);
  }

  async _sendNullPacket() {
      const packet = new Uint8Array(128);
      packet.fill(0);
      await this._sendPacket(0, packet);
  }

  async _sendPacket(seq, data) {
      // YMODEM packet structure: [STX/SOH] [SEQ] [~SEQ] [DATA] [CRC16]
      const header = new Uint8Array(3);
      header[0] = data.length > 128 ? STX : SOH;
      header[1] = seq & 0xFF;
      header[2] = (~seq) & 0xFF;

      const crc = this._crc16(data);
      const footer = new Uint8Array([(crc >> 8) & 0xFF, crc & 0xFF]);

      const fullPacket = new Uint8Array(3 + data.length + 2);
      fullPacket.set(header, 0);
      fullPacket.set(data, 3);
      fullPacket.set(footer, 3 + data.length);

      await this.ws.writeRaw(fullPacket);
  }

  _crc16(buffer) {
      let crc = 0;
      for (let byte of buffer) {
          crc = crc ^ (byte << 8);
          for (let i = 0; i < 8; i++) {
              if (crc & 0x8000) {
                  crc = (crc << 1) ^ 0x1021;
              } else {
                  crc = crc << 1;
              }
          }
      }
      return crc & 0xFFFF;
  }

  _finishYmodem() {
      this.ymodem.active = false;
      this.ws.setRawHandler(null);
      this.term.writeln('\x1b[32m[YMODEM] Done.\x1b[0m');
      document.getElementById('upload-progress-container').classList.add('hidden');

      if (this.callbacks.resumePolling) this.callbacks.resumePolling();
      setTimeout(() => this.refresh(), 1000);
  }

  _abortYmodem(reason) {
      this.ymodem.active = false;
      this.ws.setRawHandler(null);
      this.term.writeln(`\x1b[31m[YMODEM] Error: ${reason}\x1b[0m`);
      document.getElementById('upload-progress-container').classList.add('hidden');

      if (this.callbacks.resumePolling) this.callbacks.resumePolling();
  }

}
