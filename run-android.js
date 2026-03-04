const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const env = { ...process.env };
const repoRoot = __dirname;
const cordovaDir = path.join(repoRoot, 'cordova');

if (os.platform() === 'win32') {
    const jbrPath = 'C:\\Program Files\\Android\\Android Studio\\jbr';
    const sdkPath = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');

    env.JAVA_HOME = env.JAVA_HOME || jbrPath;
    env.ANDROID_HOME = env.ANDROID_HOME || sdkPath;

    const javaBin = path.join(env.JAVA_HOME, 'bin');
    let pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    if (!env[pathKey].includes(javaBin)) {
        env[pathKey] = `${javaBin};${env[pathKey]}`;
    }

    const gradleBin = path.join(os.homedir(), '.gradle', 'wrapper', 'dists', 'gradle-9.0-milestone-1-bin', '3vdepk4s12bybhohyuvjcm1bd', 'gradle-9.0-milestone-1', 'bin');
    if (!env[pathKey].includes(gradleBin)) {
        env[pathKey] = `${gradleBin};${env[pathKey]}`;
    }

    // adb is needed to detect and deploy to connected device
    const adbPath = path.join(env.ANDROID_HOME, 'platform-tools');
    if (!env[pathKey].includes(adbPath)) {
        env[pathKey] = `${adbPath};${env[pathKey]}`;
    }
}

console.log('--- Android Run Environment ---');
console.log('JAVA_HOME:', env.JAVA_HOME);
console.log('ANDROID_HOME:', env.ANDROID_HOME);
console.log('-------------------------------');

try {
    // Step 1: sync web assets into cordova/www
    execSync('node sync.js', { env, stdio: 'inherit', cwd: repoRoot });
    // Step 2: build & deploy to connected device (cwd avoids 'cd cordova')
    execSync('npx cordova run android', { env, stdio: 'inherit', cwd: cordovaDir });
} catch (error) {
    console.error('\nAndroid run failed:', error.message);
    process.exit(1);
}
