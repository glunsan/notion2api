(() => {
if (globalThis.notion2apiBridgeListenerInstalled) return;
globalThis.notion2apiBridgeListenerInstalled = true;
let currentJob = null;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.kind === 'prepare') {
    currentJob = { id: message.job.id, nonce: message.job.nonce };
    reply({ ok: true });
  } else if (message?.kind === 'clear' && currentJob?.id === message.jobId) {
    currentJob = null;
    reply({ ok: true });
  }
});
window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== window || event.origin !== 'https://app.notion.com' || !currentJob
    || data?.channel !== 'notion2api-local-bridge' || data.jobId !== currentJob.id || data.nonce !== currentJob.nonce
    || !['delta', 'done', 'error'].includes(data.kind)) return;
  chrome.runtime.sendMessage({ kind: 'result', result: data }).then(reply => {
    window.postMessage({ channel: 'notion2api-local-ack', jobId: data.jobId, nonce: data.nonce, frameId: data.frameId, ok: reply?.ok === true }, 'https://app.notion.com');
  }, () => {
    window.postMessage({ channel: 'notion2api-local-ack', jobId: data.jobId, nonce: data.nonce, frameId: data.frameId, ok: false }, 'https://app.notion.com');
  });
});
})();
