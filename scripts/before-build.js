/**
 * electron-builder beforeBuild hook.
 * Garante que a bridge seja compilada antes de empacotar o app,
 * mesmo quando o electron-builder é chamado diretamente
 * (ex: npx electron-builder --win --x64).
 */

const { spawnSync } = require('child_process');
const path = require('path');

exports.default = async function beforeBuild(_context) {
  const root = path.join(__dirname, '..');

  console.log('[before-build] compilando whatsapp-webjs-bridge...');
  const bridgeResult = spawnSync('npm', ['run', 'bridge:build'], {
    cwd: root,
    stdio: 'inherit',
    shell: true
  });
  if (bridgeResult.status !== 0) {
    throw new Error('[before-build] bridge:build falhou com código ' + bridgeResult.status);
  }
  console.log('[before-build] whatsapp-webjs-bridge compilada com sucesso.');

  console.log('[before-build] compilando Angular (ng build --configuration production)...');
  const ngResult = spawnSync('npx', ['ng', 'build', '--configuration', 'production'], {
    cwd: root,
    stdio: 'inherit',
    shell: true
  });
  if (ngResult.status !== 0) {
    throw new Error('[before-build] ng build falhou com código ' + ngResult.status);
  }
  console.log('[before-build] Angular compilado com sucesso.');
};
