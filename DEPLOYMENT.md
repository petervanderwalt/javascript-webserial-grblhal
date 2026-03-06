# Ooznest CNC - Deployment & Architecture Guide

This document explains the four distinct methods for deploying the Ooznest CNC interface to various platforms, detailing how to build, deploy, and physically connect your device to the grblHAL controller.

---

## 1. Web Deployment (Zero Install)
The purest deployment method. The application is a static HTML/JS/CSS single-page application that can be hosted anywhere.

### Deployment Method
*   **Public Web Server:** Simply upload the contents of the root folder (excluding `cordova`, `node_modules` etc.) to GitHub Pages, a standard web host, or an S3 bucket.
*   **Embedded Controller Webserver:** You can compress the UI and flash it directly onto the SD card of your grblHAL board using `Plugin_networking`. When a user navigates to the controller's IP on their local network, they are served the UI directly.

### Connectivity
*   **WebSerial (USB):** If accessed via an encrypted `https://` domain, Chrome and Edge support the native [WebSerial API](https://wicg.github.io/serial/). A user plugs a USB cable into their PC, clicks "Connect", and selects the serial port directly in the browser. 
*   **WebSocket (LAN):** If the UI is served from the controller itself (e.g. `http://192.168.1.100`), the browser can open a direct, bidirectional, low-latency WebSocket connection (`ws://192.168.1.100:81/ws`) straight to the `Plugin_networking` firmware. *Note: Browsers block WebSocket LAN connections if the website is hosted on HTTPS due to mixed-content policies.*

---

## 2. Desktop Application (Electron Builder)
For users who want a permanent, standalone application icon on their Mac, Windows, or Linux desktop without using a browser.

### Deployment Method
We use `electron-builder` to wrap the frontend in a chromium window while running a background Node.js proxy.
1. Run `npm install` to pull dependencies.
2. Build your target:
   * **Windows:** `npm run build-windows` (Produces a `.exe`)
   * **macOS:** `npm run build-macos` (Produces a `.dmg`)
   * **Linux:** `npm run build-linux` (Produces an `.AppImage`)
3. GitHub Actions also automatically builds these artifacts on every push to the `main` branch.

### Connectivity
*   **Native Node USB:** The Electron backend uses the `serialport` node module to communicate directly with the operating system's USB drivers. This bypasses the constraints of browser WebSerial and allows the backend to automatically sniff and bind to the correct COM port.
*   **Telnet (Ethernet/WiFi):** The embedded Node.js backend uses the native `net` module to establish a raw TCP socket connection to a networked grblHAL controller (e.g., port 23).

---

## 3. Android Mobile App (Cordova)
Compiles the exact same codebase into an `.apk` file that installs natively on Android phones and tablets.

### Deployment Method
1. Install Android Studio and the Android SDK (Java 17+ required).
2. The `build-android.js` script links your environment variables automatically.
3. Run `npm run build-android` to generate the APK.
4. **Direct Install:** Plug your phone in via USB and run `npm run run-android` to auto-deploy, or drag the generated `app-debug.apk` file onto your phone storage and tap to install.

> [!TIP]
> **Pro-Tip: Android Java Persistence**  
> If you encounter `javac not found` or path errors on Windows, the build scripts are optimized for the following local paths:  
> *   **JAVA_HOME:** `C:\Program Files\Android\Android Studio\jbr` (Matches Android Studio's bundled runtime)
> *   **ANDROID_HOME:** `%USERPROFILE%\AppData\Local\Android\Sdk`  
> These are automatically prioritized in `run-android.js` and `build-android.js`.  
> *Note: Using the bundled `jbr` is more reliable than standard Oracle/OpenJDK installs for Cordova 14+ compatibility.*

### Connectivity
*   **Native USB OTG:** When you connect an Android phone to the grblHAL controller using a USB-C OTG cable, the UI uses the `cordovarduino` native driver. When you tap **Connect -> Native USB**, a security prompt appears ("Allow app to access USB device?"). Once accepted, the app takes direct ownership of the STMicroelectronics CDC chip (VID: 0483, PID: 5740) bypassing the browser layer entirely.
*   **WebSocket:** If your controller is on WiFi, the Android app can also connect over the network using the WebSocket tab.

---

## 4. iOS / iPad App (Cordova)
Deploys the codebase natively to iPhones or iPads.

### Deployment Method
Apple tightly controls Xcode. You cannot compile an iOS application on a Windows machine.

**Method A: GitHub Actions + Sideloadly (Windows Users)**
1. Push your code to GitHub. The GitHub Actions pipeline will spin up a macOS cloud server, compile your app, and output an `Ooznest-iOS.ipa` file in the Actions tab.
2. Download the `.ipa` file to your Windows PC.
3. Download and install [Sideloadly](https://sideloadly.io/) (or AltStore).
4. Plug your iPad into your PC via USB.
5. Open Sideloadly, drag the `.ipa` into it, enter your Apple ID, and click Start. It will sign the app with a free developer certificate and push it to your iPad.
6. On the iPad, go to *Settings > General > VPN & Device Management* and click "Trust" on your developer email.

**Method B: Local macOS Compile (Mac Users)**
1. Clone the repo on a Mac and run `npm install`.
2. Run `npm run cordova-sync`.
3. Open the `cordova/platforms/ios/OoznestMachineControl.xcworkspace` file in Xcode.
4. Select your plugged-in iPad as the build target at the top of the window.
5. In the "Signing & Capabilities" tab, select your Personal Team.
6. Hit the "Play" button in Xcode to compile and deploy.

### Connectivity
*   **WebSocket / TCP IP:** Apple securely locks down the lightning/USB-C ports on iOS devices. The native serial OTG bridge used on Android *will not work* natively on iOS due to Apple's MFi (Made for iPhone) certification requirements. **To connect to grblHAL on an iPad, you must use the WebSocket or Telnet connections over the local WiFi network.**
