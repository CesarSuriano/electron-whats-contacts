/**
 * electron-builder beforeBuild hook.
 * Garante que a bridge seja compilada antes de empacotar o app,
 * mesmo quando o electron-builder é chamado diretamente
 * (ex: npx electron-builder --win --x64).
 */

const { spawnSync } = require('child_process');
const path = require('path');

exports.default = async function beforeBuild(_context) {
  console.log('[before-build] compilando whatsapp-webjs-bridge...');

  const result = spawnSync('npm', ['run', 'bridge:build'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: true
  });

  if (result.status !== 0) {
    throw new Error('[before-build] bridge:build falhou com código ' + result.status);
  }

  console.log('[before-build] whatsapp-webjs-bridge compilada com sucesso.');
};
