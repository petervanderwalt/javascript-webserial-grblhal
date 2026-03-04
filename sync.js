const fs = require('fs');
const path = require('path');

function copyRecursiveSync(src, dest, exclude) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (exclude.includes(path.basename(src))) return;
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(function (childItemName) {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName), exclude);
        });
    } else {
        // Only copy if it's not excluded
        fs.copyFileSync(src, dest);
    }
}

const excludes = ['node_modules', 'cordova', '.git', 'package.json', 'package-lock.json', 'sync.js', '.vscode', '.gemini'];
const srcPath = path.resolve(__dirname);
const destPath = path.join(__dirname, 'cordova', 'www');

// Ensure destination exists
if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });

// Copy all top-level files except excludes
fs.readdirSync(srcPath).forEach(item => {
    if (!excludes.includes(item)) {
        copyRecursiveSync(path.join(srcPath, item), path.join(destPath, item), excludes);
    }
});

console.log("Copied web UI to cordova/www");
