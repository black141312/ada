// An OAuth-protected remote MCP server that also serves a real tool — so the whole connector
// flow can be driven without binding anyone's actual account.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.argv[2] || 8991);
const issued = new Set();
let challenge = null;

createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const json = (o, c = 200) => res.writeHead(c, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  const body = async () => { let b = ''; for await (const c of req) b += c; return b; };

  if (u.pathname.startsWith('/.well-known/oauth-protected-resource'))
    return json({ resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`http://127.0.0.1:${port}`] });
  if (u.pathname.startsWith('/.well-known/oauth-authorization-server'))
    return json({
      issuer: `http://127.0.0.1:${port}`,
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      registration_endpoint: `http://127.0.0.1:${port}/register`,
      code_challenge_methods_supported: ['S256'],
    });
  if (u.pathname === '/register') return json({ client_id: 'flow-test-client' });

  if (u.pathname === '/authorize') {
    challenge = u.searchParams.get('code_challenge');
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'code-1');
    back.searchParams.set('state', u.searchParams.get('state'));
    setTimeout(() => fetch(back.toString()).catch(() => {}), 300);
    return json({ ok: true });
  }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(await body());
    if (createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== challenge)
      return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
    const t = `flowtok-${issued.size + 1}`;
    issued.add(t);
    return json({ access_token: t, refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer' });
  }
  if (u.pathname === '/mcp') {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!issued.has(bearer)) {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`,
      }).end();
      return;
    }
    const msg = JSON.parse((await body()) || '{}');
    if (msg.method === 'tools/list')
      return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami', description: 'Returns a fixed string, proving a remote tool reached Ada.', inputSchema: { type: 'object', properties: {} } }] } });
    if (msg.method === 'tools/call')
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'connected-and-authorized' }] } });
    return json({ jsonrpc: '2.0', id: msg.id ?? 0, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flow-test', version: '1' } } });
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`fake mcp on ${port}`));
