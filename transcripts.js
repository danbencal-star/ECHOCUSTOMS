const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = path.join(DATA_DIR, 'transcripts');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// pulls the text out of panel-style (components v2) messages
function extractText(components = []) {
  const out = [];
  for (const c of components) {
    if (typeof c.content === 'string') out.push(c.content);
    if (c.components) out.push(...extractText(c.components));
  }
  return out;
}

// turns discord text into safe html
function format(text, message) {
  let html = esc(text);
  html = html.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => {
    const name = message.mentions.users.get(id)?.username ?? 'user';
    return `<span class="mention">@${esc(name)}</span>`;
  });
  html = html.replace(/&lt;@&amp;\d+&gt;/g, '<span class="mention">@role</span>');
  html = html.replace(/&lt;#\d+&gt;/g, '<span class="mention">#channel</span>');
  html = html.replace(
    /&lt;a?:\w+:(\d+)&gt;/g,
    (m, id) => `<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.webp?size=32">`
  );
  html = html.replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (m, ts) =>
    new Date(Number(ts) * 1000).toLocaleString('en-GB', { timeZone: 'UTC' })
  );
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  return html
    .split('\n')
    .map((line) => {
      if (line.startsWith('&gt; ')) return `<div class="quote">${line.slice(5)}</div>`;
      if (line.startsWith('-# ')) return `<div class="small">${line.slice(3)}</div>`;
      const heading = line.match(/^#{1,3} (.*)/);
      if (heading) return `<div class="heading">${heading[1]}</div>`;
      return `<div>${line || '&nbsp;'}</div>`;
    })
    .join('');
}

function renderMessage(m) {
  const text = m.content || extractText(m.components).join('\n');
  const attachments = [...m.attachments.values()]
    .map((a) =>
      (a.contentType ?? '').startsWith('image/')
        ? `<img class="att" src="${esc(a.url)}">`
        : `<div><a href="${esc(a.url)}">${esc(a.name)}</a></div>`
    )
    .join('');
  const time = m.createdAt.toLocaleString('en-GB', { timeZone: 'UTC' });
  return (
    `<div class="msg"><img class="avatar" src="${esc(m.author.displayAvatarURL({ size: 64 }))}">` +
    `<div class="body"><div><span class="name">${esc(m.member?.displayName ?? m.author.username)}</span>` +
    `${m.author.bot ? '<span class="tag">APP</span>' : ''}<span class="time">${time} UTC</span></div>` +
    `${format(text, m)}${attachments}</div></div>`
  );
}

const CSS = `
body{margin:0;background:#1e1f22;color:#dbdee1;font-family:'Segoe UI',Arial,sans-serif;font-size:15px}
.wrap{max-width:900px;margin:0 auto;padding:24px 16px}
.header{background:#2b2d31;border-radius:12px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #5865f2}
.header h1{margin:0 0 14px;font-size:22px;color:#fff}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 24px}
.meta span{display:block;font-size:11px;text-transform:uppercase;color:#949ba4;letter-spacing:.5px}
.msg{display:flex;gap:14px;padding:10px 12px;border-radius:8px}
.msg:hover{background:#2b2d31}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
.name{color:#fff;font-weight:600;margin-right:8px}
.tag{background:#5865f2;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;margin-right:8px}
.time{color:#949ba4;font-size:12px}
.body{min-width:0;overflow-wrap:anywhere}
.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0;color:#b5bac1}
.heading{font-weight:700;font-size:17px;color:#fff;margin:4px 0}
.small{font-size:12px;color:#949ba4}
.mention{background:rgba(88,101,242,.3);color:#c9cdfb;padding:0 3px;border-radius:4px}
.emoji{width:22px;height:22px;vertical-align:middle}
.att{max-width:360px;max-height:300px;border-radius:8px;display:block;margin-top:6px}
a{color:#00a8fc}
.footer{text-align:center;color:#949ba4;font-size:12px;margin-top:24px}
`;

function renderPage(meta, messages) {
  const rows = meta.rows.map(([label, value]) => `<div><span>${esc(label)}</span>${esc(value)}</div>`).join('');
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${esc(meta.title)} | Transcript</title><style>${CSS}</style></head><body><div class="wrap">` +
    `<div class="header"><h1>${esc(meta.title)}</h1><div class="meta">${rows}<div><span>Messages</span>${messages.length}</div></div></div>` +
    `${messages.map(renderMessage).join('')}<div class="footer">Echo Customs transcript</div></div></body></html>`
  );
}

// grabs the whole conversation, oldest message first
async function fetchAll(channel, max = 1000) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

// builds + saves a transcript page, returns { id, html, count, url }
async function createTranscript(channel, meta) {
  const messages = await fetchAll(channel);
  const html = renderPage(meta, messages);
  const id = crypto.randomBytes(16).toString('hex');

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${id}.html`), html);

  const base = (process.env.TRANSCRIPT_BASE_URL || '').replace(/\/$/, '');
  return { id, html, count: messages.length, url: base ? `${base}/t/${id}` : null };
}

// tiny web server that shows saved transcripts at /t/<id>
function startTranscriptServer() {
  const port = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      const match = /^\/t\/([a-f0-9]{32})\/?$/.exec((req.url || '').split('?')[0]);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      fs.readFile(path.join(DIR, `${match[1]}.html`), (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Transcript not found');
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex',
          'Cache-Control': 'private',
        });
        res.end(data);
      });
    })
    .listen(port, () => console.log(`Transcript server listening on port ${port}`));
}

module.exports = { createTranscript, startTranscriptServer };