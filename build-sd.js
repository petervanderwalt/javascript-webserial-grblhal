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

    // Create dist folder
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir);
    }

    try {
        console.log('1. Bundling ES6 Modules...');

        let htmlContent = fs.readFileSync(inputPath, 'utf8');

        // Extract the <script type="module"> content
        const moduleRegex = /<script type="module">([\s\S]*?)<\/script>/;
        const match = htmlContent.match(moduleRegex);

        if (!match) {
            throw new Error('Could not find <script type="module"> block in index.html');
        }

        const moduleCode = match[1];
        const tmpEntryPath = path.join(rootDir, '_tmp_entry.js');
        const tmpBundlePath = path.join(rootDir, '_tmp_bundle.js');

        fs.writeFileSync(tmpEntryPath, moduleCode);

        // Bundle with esbuild, mirroring the importmap from index.html
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

        console.log('2. Preparing HTML for Inlining...');

        // Remove the importmap specifically for SD build as it's no longer needed
        const importMapRegex = /<script type="importmap">[\s\S]*?<\/script>/;
        let processedHtml = htmlContent.replace(importMapRegex, '');

        // Replace the module script block with a pointer to our bundle
        processedHtml = processedHtml.replace(moduleRegex, '<script inline src="_tmp_bundle.js"></script>');

        // Add "inline" attribute to other resources
        processedHtml = processedHtml.replace(/<link rel="stylesheet"/g, '<link inline rel="stylesheet"');
        processedHtml = processedHtml.replace(/<script src=/g, '<script inline src=');

        const tempHtmlPath = path.join(rootDir, '_temp_index.html');
        fs.writeFileSync(tempHtmlPath, processedHtml);

        console.log('3. Inlining all assets...');
        let inlinedHtml = await inlineSource(tempHtmlPath, {
            compress: true,
            rootpath: rootDir
        });

        // Cleanup intermediate files
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
            processConditionalComments: true,
            removeEmptyAttributes: true,
            removeRedundantAttributes: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true,
            useShortDoctype: true
        });

        fs.writeFileSync(outputHtmlPath, minifiedHtml);
        console.log(`Saved minified HTML: ${outputHtmlPath} (${(Buffer.byteLength(minifiedHtml, 'utf8') / 1024).toFixed(2)} kb)`);

        console.log('5. Compressing with GZIP for SD Card...');
        const gzip = zlib.gzipSync(Buffer.from(minifiedHtml, 'utf-8'), { level: 9 });

        fs.writeFileSync(outputGzPath, gzip);
        console.log(`Saved gzip package: ${outputGzPath} (${(gzip.length / 1024).toFixed(2)} kb)`);

        console.log('\nSuccess! Deploy `index.html.gz` to your grblHAL SD Card.');
    } catch (err) {
        console.error('Build Error:', err);
        process.exit(1);
    }
}

build();
