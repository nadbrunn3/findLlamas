import crypto from 'crypto';

export function anonPlugin(app, opts, done) {
  const COOKIE = 'anon';
  const SECRET = process.env.ANON_COOKIE_SECRET || 'dev-secret-change-me';

  function sign(val) {
    return crypto.createHmac('sha256', SECRET).update(val).digest('base64url');
  }
  function pack(id) { return `${id}.${sign(id)}`; }
  function unpack(v='') {
    const [id, sig] = v.split('.', 2);
    if (!id || !sig) return null;
    if (sign(id) !== sig) return null;
    return id;
  }
  function newId() {
    return crypto.randomUUID(); // node >=16.14
  }

  app.addHook('onRequest', (req, reply, doneHook) => {
    const raw = req.cookies?.[COOKIE]; // make sure you registered @fastify/cookie
    let id = unpack(raw);
    if (!id) {
      id = newId();
      reply.setCookie(COOKIE, pack(id), {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,          // set to true in production (https)
        path: '/',
        maxAge: 60 * 60 * 24 * 365 * 5, // 5 years
      });
    }
    req.anonId = id;
    doneHook();
  });

  done();
}
