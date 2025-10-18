const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.resolve(__dirname, '..', 'tmp', 'webview.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script nonce="\$\{nonce\}">([\s\S]*)<\/script>/);
if (!scriptMatch) {
	throw new Error('Unable to locate script in webview HTML.');
}
const scriptContent = scriptMatch[1];
const context = {
	window: {
		addEventListener: () => {}
	},
	document: {
		getElementById: () => ({ addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '', appendChild() {}, setAttribute() {} }),
		querySelector: () => ({ innerHTML: '' }),
		createElement: () => ({ appendChild() {}, setAttribute() {}, style: {} }),
	},
	vscodeApi: { postMessage: () => {} },
	acquireVsCodeApi: () => ({ postMessage: () => {} })
};
try {
	vm.runInNewContext(scriptContent, context);
	console.log('Script parsed successfully.');
} catch (error) {
	console.error('Script evaluation error:', error);
}
