const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const env = { ...process.env };

if (os.platform() === 'win32') {
    // Known Good Paths for the User
    const jbrPath = 'C:\\Program Files\\Android\\Android Studio\\jbr';
    const sdkPath = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');

    // Prioritize configured paths, or falling back to standard install locations
    env.JAVA_HOME = env.JAVA_HOME || jbrPath;
    env.ANDROID_HOME = env.ANDROID_HOME || sdkPath;
    env.ANDROID_SDK_ROOT = env.ANDROID_HOME; // Backward compatibility

    const javaBin = path.join(env.JAVA_HOME, 'bin');
    const adbPath = path.join(env.ANDROID_HOME, 'platform-tools');

    let pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';

    // ENSURE JAVA and ADB ARE AT THE FRONT
    let currentPath = env[pathKey] || '';
    env[pathKey] = `${javaBin};${adbPath};${currentPath}`;

    // Try to find any installed gradle if it's not already on path or specified
    const gradleBin = path.join(os.homedir(), '.gradle', 'wrapper', 'dists', 'gradle-9.0-milestone-1-bin', '3vdepk4s12bybhohyuvjcm1bd', 'gradle-9.0-milestone-1', 'bin');
    if (require('fs').existsSync(gradleBin)) {
        env[pathKey] = `${gradleBin};${env[pathKey]}`;
    }
}

console.log('--- Android Build Environment ---');
console.log('JAVA_HOME:', env.JAVA_HOME);
console.log('ANDROID_HOME:', env.ANDROID_HOME);
console.log('---------------------------------');

try {
    // Ensure we can see javac
    try {
        const javacVer = execSync('javac -version', { env, encoding: 'utf8' });
        console.log('Using javac:', javacVer.trim());
    } catch (e) { }

    // Sync and Build
    execSync('npm run cordova-sync && cd cordova && npx cordova build android --verbose', { env, stdio: 'inherit' });
} catch (error) {
    console.error('Android build failed:', error.message);
    process.exit(1);
}
