const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const bridgeDir = path.join(__dirname, '..', 'whatsapp-webjs-bridge');
const nodeModules = path.join(bridgeDir, 'node_modules');

if (existsSync(nodeModules)) {
  process.exit(0);
}

console.log('[bridge] instalando dependencias em whatsapp-webjs-bridge...');
const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: bridgeDir,
  stdio: 'inherit',
  shell: true
});

process.exit(result.status || 0);
