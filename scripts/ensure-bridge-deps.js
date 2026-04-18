const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const bridgeDir = path.join(__dirname, '..', 'whatsapp-webjs-bridge');
const nodeModules = path.join(bridgeDir, 'node_modules');
const distEntry = path.join(bridgeDir, 'dist', 'server.js');

if (!existsSync(nodeModules)) {
  console.log('[bridge] instalando dependencias em whatsapp-webjs-bridge...');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: bridgeDir,
    stdio: 'inherit',
    shell: true
  });
  if (install.status) {
    process.exit(install.status);
  }
}

if (!existsSync(distEntry)) {
  console.log('[bridge] compilando whatsapp-webjs-bridge (tsc)...');
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: bridgeDir,
    stdio: 'inherit',
    shell: true
  });
  process.exit(build.status || 0);
}

process.exit(0);
