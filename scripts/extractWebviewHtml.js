const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(__dirname, '..', 'src', 'extension.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const startToken = 'const html = `<!DOCTYPE html>';
const endToken = '</html>`;';
const startIndex = source.indexOf(startToken);
if (startIndex === -1) {
	throw new Error('Unable to locate webview HTML start token.');
}
const contentStart = startIndex + startToken.length;
const endIndex = source.indexOf(endToken, contentStart);
if (endIndex === -1) {
	throw new Error('Unable to locate webview HTML end token.');
}
const htmlBody = source.slice(contentStart, endIndex);
const html = '<!DOCTYPE html>' + htmlBody + '</html>';

const outputPath = path.resolve(__dirname, '..', 'tmp', 'webview.html');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html, 'utf8');
console.log('Webview HTML written to', outputPath);
