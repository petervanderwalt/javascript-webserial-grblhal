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
        console.log('1. Bundling ES6 Modules & 3D Assets...');

        // Internalize STLs
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

        const moduleRegex = /<script type="module">([\s\S]*?)<\/script>/;
        const match = htmlContent.match(moduleRegex);
        if (!match) throw new Error('Could not find <script type="module"> block');

        const moduleCode = match[1];
        const tmpEntryPath = path.join(rootDir, '_tmp_entry.js');
        const tmpBundlePath = path.join(rootDir, '_tmp_bundle.js');
        fs.writeFileSync(tmpEntryPath, moduleCode);

        // JS Bundle
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

        let bundleJs = fs.readFileSync(tmpBundlePath, 'utf8');
        for (const [url, data] of Object.entries(stlData)) {
            bundleJs = bundleJs.split(url).join(data); // Faster than Regex for large blobs
        }
        fs.writeFileSync(tmpBundlePath, bundleJs);

        console.log('2. Internalizing Fonts & CSS Dependencies...');

        function inlineFontsInCss(cssFilePath, seen = new Set()) {
            if (seen.has(cssFilePath)) return '';
            seen.add(cssFilePath);
            let css = fs.readFileSync(cssFilePath, 'utf8');
            const cssDir = path.dirname(cssFilePath);

            // 1. Resolve @import
            css = css.replace(/@import\s+(?:url\(['"]?([^'"]+)['"]?\)|['"]?([^'"]+)['"]?);/g, (match, url1, url2) => {
                const importPath = url1 || url2;
                const absoluteImportPath = path.resolve(cssDir, importPath);
                if (fs.existsSync(absoluteImportPath)) {
                    console.log(`   - Resolving @import: ${importPath}`);
                    return inlineFontsInCss(absoluteImportPath, seen);
                }
                return match;
            });

            // 2. Base64 url() - handles fonts with query params and varying extensions
            css = css.replace(/url\(['"]?([^'")]+?)['"]?\)/g, (match, url) => {
                if (url.startsWith('data:') || url.startsWith('http') || url.startsWith('//')) return match;

                // Strip query string/hash
                const cleanFontPath = url.split('?')[0].split('#')[0];
                const absoluteFontPath = path.resolve(cssDir, cleanFontPath);

                if (fs.existsSync(absoluteFontPath)) {
                    const ext = path.extname(cleanFontPath).toLowerCase().replace('.', '');
                    // Only process common font/asset formats
                    const fontExts = ['ttf', 'woff', 'woff2', 'eot', 'svg', 'otf', 'png', 'jpg', 'jpeg', 'gif'];
                    if (fontExts.includes(ext)) {
                        console.log(`   - Internalizing: ${cleanFontPath}`);
                        const buffer = fs.readFileSync(absoluteFontPath);
                        let mime;
                        switch (ext) {
                            case 'ttf': mime = 'font/ttf'; break;
                            case 'woff': mime = 'font/woff'; break;
                            case 'woff2': mime = 'font/woff2'; break;
                            case 'svg': mime = 'image/svg+xml'; break;
                            case 'png': mime = 'image/png'; break;
                            case 'jpg': case 'jpeg': mime = 'image/jpeg'; break;
                            default: mime = 'application/octet-stream';
                        }
                        return `url("data:${mime};base64,${buffer.toString('base64')}")`;
                    }
                }
                return match;
            });

            return css;
        }

        const mainCssPath = path.join(rootDir, 'themes', 'ooznest.css');
        const internalizedCss = inlineFontsInCss(mainCssPath);
        const tmpCssPath = path.join(rootDir, '_tmp_ooznest.css');
        fs.writeFileSync(tmpCssPath, internalizedCss);

        console.log('3. Structural HTML preparation...');

        const importMapRegex = /<script type="importmap">[\s\S]*?<\/script>/g;
        const cordovaScriptRegex = /<script>\s*\(function\s*\(\)\s*\{\s*var\s*s\s*=\s*document\.createElement\('script'\);\s*s\.src\s*=\s*'cordova\.js'[\s\S]*?<\/script>/g;

        let processedHtml = htmlContent
            .replace(importMapRegex, '')
            .replace(cordovaScriptRegex, '<!-- cordova.js removed for SD -->')
            .replace(moduleRegex, '<script inline src="_tmp_bundle.js"></script>');

        processedHtml = processedHtml.replace(/href="themes\/ooznest\.css"/, 'href="_tmp_ooznest.css"');

        // Robust link/script/img inlining
        processedHtml = processedHtml.replace(/<(link|script|img)\s+([^>]+)>/g, (match, tag, attrs) => {
            if (attrs.includes('inline')) return match;
            if (attrs.includes('http') || attrs.includes('//')) return match;

            if (tag === 'link' && attrs.includes('rel="stylesheet"')) { return `<link inline ${attrs}>`; }
            if (tag === 'script' && attrs.includes('src=')) { return `<script inline ${attrs}></script>`; }
            if (tag === 'img' && attrs.includes('src=')) { return `<img inline ${attrs}>`; }
            return match;
        });

        const tempHtmlPath = path.join(rootDir, '_temp_index.html');
        fs.writeFileSync(tempHtmlPath, processedHtml);

        console.log('4. Inlining assets (Images, CSS, JS)...');
        let inlinedHtml = await inlineSource(tempHtmlPath, {
            compress: true,
            rootpath: rootDir,
            attribute: 'inline'
        });

        // Cleanup
        try { fs.unlinkSync(tmpEntryPath); } catch (e) { }
        try { fs.unlinkSync(tmpBundlePath); } catch (e) { }
        try { fs.unlinkSync(tmpCssPath); } catch (e) { }
        try { fs.unlinkSync(tempHtmlPath); } catch (e) { }

        console.log('5. Aggressive Minification...');
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

        console.log('6. Final GZIP compression...');
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
