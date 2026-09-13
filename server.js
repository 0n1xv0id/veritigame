const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const GAMES_DIR = path.join(ROOT, 'games');
const DATA_DIR = path.join(ROOT, 'data');

[GAMES_DIR, DATA_DIR].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let users = loadJSON(path.join(DATA_DIR, 'users.json'), {});
let games = loadJSON(path.join(DATA_DIR, 'games.json'), []);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.py': 'text/plain; charset=utf-8'
};

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 5 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  /* ============= AUTH ============= */
  if (url === '/api/auto-login' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, pass } = JSON.parse(body);
        const u = users[nick.toLowerCase()];
        if (!u) return sendJSON(res, 404, { error: 'Не найден' });
        // Если передан пароль — проверяем; если нет — доверяем сессии
        if (pass && u.pass !== pass) return sendJSON(res, 401, { error: 'Неверный пароль' });
        sendJSON(res, 200, { ok: true, nick: u.nick, isModerator: !!u.isModerator });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  if (url === '/api/register' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, pass } = JSON.parse(body);
        if (!nick || !pass) return sendJSON(res, 400, { error: 'Заполни поля' });
        if (nick.length < 2) return sendJSON(res, 400, { error: 'Ник минимум 2 символа' });
        if (pass.length < 3) return sendJSON(res, 400, { error: 'Пароль минимум 3 символа' });
        const key = nick.toLowerCase();
        if (users[key]) return sendJSON(res, 400, { error: 'Ник занят' });
        users[key] = { nick, pass, created: Date.now(), isModerator: false };
        saveJSON(path.join(DATA_DIR, 'users.json'), users);
        sendJSON(res, 200, { ok: true, nick });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  if (url === '/api/login' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, pass } = JSON.parse(body);
        const u = users[nick.toLowerCase()];
        if (!u || u.pass !== pass) return sendJSON(res, 400, { error: 'Неверный ник или пароль' });
        sendJSON(res, 200, { ok: true, nick: u.nick, isModerator: !!u.isModerator });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  /* ============= GAMES ============= */
  // Публичный список (только одобренные)
  if (url === '/api/games' && method === 'GET') {
    const list = games.filter(g => g.status === 'approved').map(g => ({
      id: g.id, name: g.name, author: g.author, desc: g.desc,
      category: g.category, plays: g.plays, date: g.date
    }));
    return sendJSON(res, 200, list);
  }

  // Одна игра
  if (url === '/api/game' && method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const game = games.find(g => g.id === id);
    if (!game) return sendJSON(res, 404, { error: 'Игра не найдена' });
    if (game.status !== 'approved') return sendJSON(res, 403, { error: 'Игра ещё не одобрена' });
    sendJSON(res, 200, game);
  }

  // Загрузка игры (теперь идёт на модерацию)
  if (url === '/api/upload' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { name, author, desc, category, code } = JSON.parse(body);
        if (!name || !author || !code) return sendJSON(res, 400, { error: 'Заполни поля' });
        if (code.length > 100000) return sendJSON(res, 400, { error: 'Файл слишком большой (макс 100KB)' });

        const id = 'game_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const game = {
          id, name, author, desc: desc || '', category: category || 'Разное',
          code, plays: 0, date: Date.now(),
          status: 'pending',           // pending | approved | rejected
          reviewedBy: null,
          reviewedAt: null,
          rejectReason: ''
        };
        games.push(game);
        saveJSON(path.join(DATA_DIR, 'games.json'), games);
        fs.writeFileSync(path.join(GAMES_DIR, id + '.py'), code, 'utf8');
        sendJSON(res, 200, { ok: true, id, status: 'pending' });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  // Счётчик проигрываний
  if (url === '/api/play' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { id } = JSON.parse(body);
        const g = games.find(x => x.id === id);
        if (g) { g.plays++; saveJSON(path.join(DATA_DIR, 'games.json'), games); }
        sendJSON(res, 200, { ok: true });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  // Мои загрузки (со статусами)
  if (url === '/api/my-games' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick } = JSON.parse(body);
        const list = games.filter(g => g.author === nick).map(g => ({
          id: g.id, name: g.name, category: g.category, status: g.status,
          rejectReason: g.rejectReason, date: g.date, plays: g.plays
        }));
        sendJSON(res, 200, list);
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  /* ============= MODERATION ============= */
  const MOD_CODE = '14629';

  // Пользователь вводит код → получает статус модератора
  if (url === '/api/become-moderator' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, code } = JSON.parse(body);
        if (code !== MOD_CODE) return sendJSON(res, 400, { error: 'Неверный код' });
        const u = users[nick.toLowerCase()];
        if (!u) return sendJSON(res, 400, { error: 'Пользователь не найден' });
        u.isModerator = true;
        saveJSON(path.join(DATA_DIR, 'users.json'), users);
        sendJSON(res, 200, { ok: true });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  // Список игр на модерации (только для модераторов)
  if (url === '/api/moderation/list' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick } = JSON.parse(body);
        const u = users[nick.toLowerCase()];
        if (!u || !u.isModerator) return sendJSON(res, 403, { error: 'Нет доступа' });
        const pending = games.filter(g => g.status === 'pending').map(g => ({
          id: g.id, name: g.name, author: g.author, desc: g.desc,
          category: g.category, date: g.date, codePreview: g.code.slice(0, 200)
        }));
        const approved = games.filter(g => g.status === 'approved').length;
        const rejected = games.filter(g => g.status === 'rejected').length;
        sendJSON(res, 200, {
          pending,
          stats: { approved, rejected, pending: pending.length }
        });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  // Полный код конкретной игры (для просмотра модератором)
  if (url === '/api/moderation/game' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, id } = JSON.parse(body);
        const u = users[nick.toLowerCase()];
        if (!u || !u.isModerator) return sendJSON(res, 403, { error: 'Нет доступа' });
        const game = games.find(g => g.id === id);
        if (!game) return sendJSON(res, 404, { error: 'Не найдено' });
        sendJSON(res, 200, game);
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  // Одобрить / отклонить
  if (url === '/api/moderation/review' && method === 'POST') {
    return readBody(req, body => {
      try {
        const { nick, id, action, reason } = JSON.parse(body);
        const u = users[nick.toLowerCase()];
        if (!u || !u.isModerator) return sendJSON(res, 403, { error: 'Нет доступа' });
        const game = games.find(g => g.id === id);
        if (!game) return sendJSON(res, 404, { error: 'Игра не найдена' });
        if (action === 'approve') {
          game.status = 'approved';
          game.rejectReason = '';
        } else if (action === 'reject') {
          game.status = 'rejected';
          game.rejectReason = reason || 'Без причины';
        } else {
          return sendJSON(res, 400, { error: 'Неизвестное действие' });
        }
        game.reviewedBy = nick;
        game.reviewedAt = Date.now();
        saveJSON(path.join(DATA_DIR, 'games.json'), games);
        sendJSON(res, 200, { ok: true });
      } catch(e) { sendJSON(res, 400, { error: 'Bad JSON' }); }
    });
  }

  /* ============= STATIC ============= */
  let filePath = path.join(ROOT, url === '/' ? 'index.html' : decodeURIComponent(url));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

function getIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║        VeritiGame Server             ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  Локально:  http://localhost:' + PORT);
  console.log('  Для друга: http://' + getIP() + ':' + PORT);
  console.log('');
  console.log('  Код модератора: 14629');
  console.log('');
});
