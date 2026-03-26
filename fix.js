const fs = require('fs');
const file = 'c:\\Users\\User\\Documents\\GITHUB\\PETERVANDERWALT\\javascript-webserial-grblhal\\.github\\workflows\\cross-platform-builds.yml';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let currentJob = null;
const targetJobs = ['build-android:', 'build-ios:', 'build-windows:', 'build-macos:', 'build-linux:', 'build-sd:'];

let newLines = [];
let skipNextSteps = 0;
for (let i = 0; i < lines.length; i++) {
    if (skipNextSteps > 0) { skipNextSteps--; continue; }
    
    let line = lines[i];
    
    if (line.match(/^  build-[a-z]+:$/)) {
        currentJob = line.trim();
    } 
    else if (line.match(/^  [a-z]+:/)) {
        currentJob = null;
    }
    
    // Fix iOS zip naming
    if (currentJob === 'build-ios:' && line.trim() === 'zip -r Ooznest-iOS.ipa Payload/') {
        newLines.push('          VERSION=$(node -p "require(\'../../package.json\').version")');
        newLines.push('          zip -r javascript-webserial-grblhal-${VERSION}-iOS.ipa Payload/');
        continue;
    }
    if (currentJob === 'build-ios:' && line.trim() === 'path: cordova/Ooznest-iOS.ipa') {
        newLines.push('          path: cordova/*.ipa');
        continue;
    }
    
    // Fix Android APK naming
    if (currentJob === 'build-android:' && line.trim() === 'cordova build android') {
        newLines.push(line);
        newLines.push('          VERSION=$(node -p "require(\'./package.json\').version")');
        newLines.push('          mv cordova/platforms/android/app/build/outputs/apk/debug/app-debug.apk cordova/platforms/android/app/build/outputs/apk/debug/javascript-webserial-grblhal-${VERSION}-Android.apk || true');
        continue;
    }

    newLines.push(line);
    
    if (currentJob && targetJobs.includes(currentJob)) {
        // Avoid duplicate additions
        if (line.startsWith('    name:')) {
            // Check next line to avoid duplicating if already there
            if (i+1 < lines.length && !lines[i+1].includes('needs: bump-version')) {
                newLines.push('    needs: bump-version');
            }
        }
        
        if (line.trim() === '- uses: actions/checkout@v4') {
            if (i+1 < lines.length && !lines[i+1].includes('with:')) {
                newLines.push('        with:');
                newLines.push('          ref: ${{ needs.bump-version.outputs.new_version }}');
            }
        }
    }
}

fs.writeFileSync(file, newLines.join('\n'));
console.log('Fixed workflow definition');
