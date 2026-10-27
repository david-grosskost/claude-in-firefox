async function refresh() {
  const { connected, ports } = await browser.runtime.sendMessage({ type: 'status' });
  document.getElementById('status').className = connected ? 'on' : '';
  document.getElementById('label').textContent = connected
    ? `Connecté à ${connected} session(s) Claude Code`
    : 'En attente de Claude Code…';
  document.getElementById('hint').textContent = connected
    ? `Port(s) : ${ports.join(', ')}`
    : 'Lancez Claude Code avec le serveur MCP « firefox » configuré (voir README).';
}
refresh();
setInterval(refresh, 1000);
