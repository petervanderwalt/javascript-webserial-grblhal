const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const inlineSource = require('inline-source').inlineSource;
const { minify } = require('html-minifier-terser');
const esbuild = require('esbuild');

async function build() {
    const rootDir = __dirname;
    const distDir = path.join(rootDir, 'dist');
    const inputPath = path.join(rootDir, 'index.html');
    const outputHtmlPath = path.join(distDir, 'index.html');
    const outputGzPath = path.join(distDir, 'index.html.gz');

    console.log('Building SD Card WebUI package...');

    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir);
    }

    try {
        console.log('1. Bundling ES6 Modules & Assets...');

        // Convert large binary assets to Data URIs to ensure "Single File" behavior
        const stlFiles = ['endmill.stl', 'collet-nut.stl', 'collet-shaft.stl'];
        const stlData = {};
        for (const file of stlFiles) {
            const filePath = path.join(rootDir, file);
            if (fs.existsSync(filePath)) {
                console.log(`   - Internalizing ${file}...`);
                const buffer = fs.readFileSync(filePath);
                stlData[`./${file}`] = `data:application/sla;base64,${buffer.toString('base64')}`;
            }
        }

        let htmlContent = fs.readFileSync(inputPath, 'utf8');

        // Extract the <script type="module"> content
        const moduleRegex = /<script type="module">([\s\S]*?)<\/script>/;
        const match = htmlContent.match(moduleRegex);

        if (!match) {
            throw new Error('Could not find <script type="module"> block');
        }

        const moduleCode = match[1];
        const tmpEntryPath = path.join(rootDir, '_tmp_entry.js');
        const tmpBundlePath = path.join(rootDir, '_tmp_bundle.js');

        fs.writeFileSync(tmpEntryPath, moduleCode);

        // Bundle JS
        await esbuild.build({
            entryPoints: [tmpEntryPath],
            bundle: true,
            outfile: tmpBundlePath,
            minify: true,
            format: 'iife',
            target: ['es2015'],
            alias: {
                'three': path.join(rootDir, 'vendor', 'three.module.js'),
                'three/addons': path.join(rootDir, 'vendor', 'jsm')
            },
            loader: { '.js': 'js' }
        });

        // Replace STL URLs in the bundle with our Data URIs
        let bundleJs = fs.readFileSync(tmpBundlePath, 'utf8');
        for (const [url, data] of Object.entries(stlData)) {
            const escapedUrl = url.replace(/\./g, '\\.');
            bundleJs = bundleJs.replace(new RegExp(escapedUrl, 'g'), data);
        }
        fs.writeFileSync(tmpBundlePath, bundleJs);

        console.log('2. Structural HTML preparation...');

        // Targeted removal of specific blocks
        const importMapRegex = /<script type="importmap">[\s\S]*?<\/script>/g;

        // Match the specific cordova.js injector code specifically to avoid over-matching
        const cordovaScriptRegex = /<script>\s*\(function\s*\(\)\s*\{\s*var\s*s\s*=\s*document\.createElement\('script'\);\s*s\.src\s*=\s*'cordova\.js'[\s\S]*?<\/script>/g;

        let processedHtml = htmlContent
            .replace(importMapRegex, '')
            .replace(cordovaScriptRegex, '<!-- cordova.js removed for SD -->')
            .replace(moduleRegex, '<script inline src="_tmp_bundle.js"></script>');

        // Robust link/script/img inlining (adds 'inline' attribute to any relative source)
        processedHtml = processedHtml.replace(/<(link|script|img)\s+([^>]+)>/g, (match, tag, attrs) => {
            if (attrs.includes('inline')) return match;
            if (attrs.includes('http') || attrs.includes('//')) return match; // Skip remote

            if (tag === 'link' && attrs.includes('rel="stylesheet"')) {
                return `<link inline ${attrs}>`;
            }
            if (tag === 'script' && attrs.includes('src=')) {
                return `<script inline ${attrs}></script>`;
            }
            if (tag === 'img' && attrs.includes('src=')) {
                return `<img inline ${attrs}>`;
            }
            return match;
        });

        const tempHtmlPath = path.join(rootDir, '_temp_index.html');
        fs.writeFileSync(tempHtmlPath, processedHtml);

        console.log('3. Inlining assets (Images, CSS, JS)...');
        let inlinedHtml = await inlineSource(tempHtmlPath, {
            compress: true,
            rootpath: rootDir,
            attribute: 'inline'
        });

        // Cleanup
        try { fs.unlinkSync(tmpEntryPath); } catch (e) { }
        try { fs.unlinkSync(tmpBundlePath); } catch (e) { }
        try { fs.unlinkSync(tempHtmlPath); } catch (e) { }

        console.log('4. Aggressive Minification...');
        const minifiedHtml = await minify(inlinedHtml, {
            collapseWhitespace: true,
            removeComments: true,
            minifyJS: true,
            minifyCSS: true,
            removeAttributeQuotes: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true,
            useShortDoctype: true
        });

        fs.writeFileSync(outputHtmlPath, minifiedHtml);

        console.log('5. Final GZIP compression...');
        const gzip = zlib.gzipSync(Buffer.from(minifiedHtml, 'utf-8'), { level: 9 });
        fs.writeFileSync(outputGzPath, gzip);

        console.log(`\nDONE!`);
        console.log(`Final Package Size: ${(gzip.length / 1024 / 1024).toFixed(2)} MB (Gzipped)`);
        console.log(`Deployment: Copy dist/index.html.gz to SD Card.`);
    } catch (err) {
        console.error('Build Error:', err);
        process.exit(1);
    }
}

build();
