const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const env = { ...process.env };

if (os.platform() === 'win32') {
    // Default paths for Android Studio on Windows
    const jbrPath = 'C:\\Program Files\\Android\\Android Studio\\jbr';
    const sdkPath = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');

    env.JAVA_HOME = env.JAVA_HOME || jbrPath;
    env.ANDROID_HOME = env.ANDROID_HOME || sdkPath;

    const javaBin = path.join(env.JAVA_HOME, 'bin');
    let pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    if (!env[pathKey].includes(javaBin)) {
        env[pathKey] = `${javaBin};${env[pathKey]}`;
    }

    // Add gradle to path
    const gradleBin = path.join(os.homedir(), '.gradle', 'wrapper', 'dists', 'gradle-9.0-milestone-1-bin', '3vdepk4s12bybhohyuvjcm1bd', 'gradle-9.0-milestone-1', 'bin');
    if (!env[pathKey].includes(gradleBin)) {
        env[pathKey] = `${gradleBin};${env[pathKey]}`;
    }
}

console.log('--- Android Build Environment ---');
console.log('JAVA_HOME:', env.JAVA_HOME);
console.log('ANDROID_HOME:', env.ANDROID_HOME);
console.log('---------------------------------');

try {
    execSync('npm run cordova-sync && cd cordova && npx cordova build android', { env, stdio: 'inherit' });
} catch (error) {
    console.error('Android build failed:', error.message);
    process.exit(1);
}
