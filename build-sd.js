const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const inlineSource = require('inline-source').inlineSource;
const { minify } = require('html-minifier-terser');

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
        console.log('1. Inlining CSS and JS constraints...');

        // inlineSource requires <script inline src="..."> or <link inline rel="...">
        // Since we cannot modify the original safely without risking standard devs,
        // we'll explicitly pass the right options. (Or we can dynamically add 'inline' attributes).

        let htmlContent = fs.readFileSync(inputPath, 'utf8');

        // Add "inline" attribute to standard css and scripts so inline-source processes them
        htmlContent = htmlContent.replace(/<link rel="stylesheet"/g, '<link inline rel="stylesheet"');
        htmlContent = htmlContent.replace(/<script src=/g, '<script inline src=');
        htmlContent = htmlContent.replace(/<script type="module" src=/g, '<script inline type="module" src=');

        // Write a temp file for processing
        const tempPath = path.join(rootDir, '_temp_index.html');
        fs.writeFileSync(tempPath, htmlContent);

        let html = await inlineSource(tempPath, {
            compress: true,
            rootpath: rootDir
        });

        // Cleanup temp
        fs.unlinkSync(tempPath);

        console.log('2. Minifying HTML structure...');
        const minifiedHtml = await minify(html, {
            collapseWhitespace: true,
            removeComments: true,
            minifyJS: true,
            minifyCSS: true,
            removeAttributeQuotes: true
        });

        fs.writeFileSync(outputHtmlPath, minifiedHtml);
        console.log(`Saved minified HTML: ${outputHtmlPath} (${(Buffer.byteLength(minifiedHtml, 'utf8') / 1024).toFixed(2)} kb)`);

        console.log('3. Compressing with GZIP...');
        const gzip = zlib.gzipSync(Buffer.from(minifiedHtml, 'utf-8'));

        fs.writeFileSync(outputGzPath, gzip);
        console.log(`Saved gzip package: ${outputGzPath} (${(gzip.length / 1024).toFixed(2)} kb)`);

        console.log('Done! Deploy `index.html.gz` to the root of your grblHAL SD Card.');
    } catch (err) {
        console.error('Build Error:', err);
    }
}

build();
