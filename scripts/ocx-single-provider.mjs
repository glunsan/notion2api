// Run only with the Bun runtime bundled with the already-installed OpenCodex.
// Input is a PUBLIC snapshot/row over stdin; provider keys use the normal CLI separately.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function refuse(code) { throw Object.assign(new Error(code), { safeCode: code }); }
let stage = 'preflight';
try {
  const root = resolve(process.argv[2] || '');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@bitkyc08/opencodex' || pkg.version !== '2.81.0') refuse('unsupported_install');
  const { runtimeBaseUrl, runtimeRequest } = await import(pathToFileURL(join(root, 'src/cli/runtime-api.ts')).href);
  const { parseProviderEditorConfigDTO } = await import(pathToFileURL(join(root, 'src/server/auth-cors.ts')).href);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) refuse('input_too_large');
  }
  const { operation, baseline, row, ...unknown } = JSON.parse(input);
  if (Object.keys(unknown).length || !['create', 'enable'].includes(operation)
    || !parseProviderEditorConfigDTO(baseline).ok || !row || typeof row !== 'object' || Array.isArray(row)) refuse('invalid_input');
  const destination = new URL(row.baseUrl);
  if (destination.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname)
    || destination.username || destination.password || destination.search || destination.hash
    || destination.pathname.replace(/\/$/, '') !== '/v1' || row.adapter !== 'openai-chat'
    || row.authMode !== 'key' || row.allowPrivateNetwork !== true || row.disabled !== true
    || typeof row.note !== 'string' || !/^Notion2API localhost bridge; connect-opencodex\.ps1 registration [0-9a-f]{32}$/.test(row.note)
    || !parseProviderEditorConfigDTO({ defaultProvider: 'notion2api', providers: { notion2api: row } }).ok) refuse('invalid_row');
  stage = 'locate';
  const baseUrl = await runtimeBaseUrl();
  const management = new URL(baseUrl);
  if (management.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(management.hostname)
    || management.username || management.password || management.search || management.hash) refuse('nonlocal_management');
  const deps = { baseUrl };
  async function snapshot() {
    const data = await runtimeRequest('/api/config', { method: 'GET', redirect: 'error' }, deps);
    const providers = Object.fromEntries(Object.entries(data.providers).map(([name, provider]) => {
      const { hasApiKey, hasHeaders, xaiResponsesOptInState, initialModelSelection, ...editable } = provider;
      return [name, editable];
    }));
    const result = { defaultProvider: data.defaultProvider, providers };
    if (!parseProviderEditorConfigDTO(result).ok) refuse('invalid_snapshot');
    return result;
  }
  stage = 'read';
  const before = await snapshot();
  if (!isDeepStrictEqual(before, baseline)) refuse('stale_baseline');
  if (operation === 'create') {
    if (Object.hasOwn(before.providers, 'notion2api')) refuse('provider_exists');
  } else if (!isDeepStrictEqual(before.providers.notion2api, row)) refuse('ownership_changed');
  stage = operation;
  const receipt = await runtimeRequest(operation === 'create' ? '/api/providers' : '/api/providers?name=notion2api', {
    method: operation === 'create' ? 'POST' : 'PATCH', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation === 'create' ? { name: 'notion2api', provider: row, setDefault: false } : { disabled: false })
  }, deps);
  if (receipt.success !== true) refuse('invalid_receipt');
  stage = 'readback';
  const after = await snapshot();
  const expected = structuredClone(before);
  expected.providers.notion2api = operation === 'create' ? row : { ...row, disabled: false };
  if (!isDeepStrictEqual(after, expected)) refuse('readback_changed');
  console.log(JSON.stringify({ success: true, operation, defaultProvider: after.defaultProvider }));
} catch (error) {
  // Never stringify the exception, credentials, or upstream/management error body.
  const code = error.safeCode || 'management_operation_failed';
  console.error(JSON.stringify({ success: false, code, stage, ...(Number.isInteger(error.status) ? { status: error.status } : {}) }));
  process.exitCode = 1;
}
