import fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import fs from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';
import dotenv from 'dotenv';

dotenv.config();

/* ------------ Config ------------ */
const PORT = Number(process.env.PORT) || 4000;
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const DAYS_DIR = path.join(REPO_DIR, 'public', 'days');
const INTERACTIONS_DIR = path.join(REPO_DIR, 'public', 'interactions');
const SHOULD_PUSH = String(process.env.GIT_PUSH).toLowerCase() === 'true';

const git = simpleGit(REPO_DIR);

/* ------------ Fastify ------------ */
const app = fastify({ logger: true });
app.register(cors, { origin: true });

// Serve static files from public directory
app.register(staticFiles, {
  root: path.join(REPO_DIR, 'public'),
  prefix: '/', // optional: default '/'
});

/* ------------ Small utils ------------ */

// Per-file mutex to avoid concurrent writes clobbering each other
const locks = new Map();
async function withFileLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const p = new Promise((res) => (release = res));
  locks.set(key, prev.then(() => p));
  try {
    return await fn();
  } finally {
    release();
    // Clean up if this promise is the tail
    if (locks.get(key) === p) locks.delete(key);
  }
}

// Atomic JSON write (write to .tmp then rename)
async function writeJsonAtomic(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function readJson(filePath, def = []) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return def;
  }
}

// Safe join that ensures the resolved path stays under base
function safeJoin(base, ...segs) {
  const target = path.resolve(base, ...segs);
  if (!target.startsWith(path.resolve(base) + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return target;
}

/* ------------ Validation helpers ------------ */
const DAY_SLUG_RE = /^\d{4}-\d{2}-\d{2}$/;         // e.g., 2025-08-14
const ID_RE = /^[A-Za-z0-9_\-]+$/;                 // simple ids like p1, stack-123_abc

function assertDaySlug(slug) {
  if (!DAY_SLUG_RE.test(slug)) {
    const e = new Error('Invalid slug');
    e.statusCode = 400;
    throw e;
  }
}

function assertId(id, label = 'id') {
  if (!ID_RE.test(id)) {
    const e = new Error(`Invalid ${label}`);
    e.statusCode = 400;
    throw e;
  }
}

/* ------------ Git helpers ------------ */
async function gitStageCommitPush(files, message) {
  try {
    await git.add(files);
    await git.commit(message);
    if (SHOULD_PUSH) {
      try {
        await git.push();
      } catch (err) {
        // Don’t fail the request if push fails (remote may not be set)
        console.warn('Git push failed:', err?.message || err);
      }
    }
  } catch (err) {
    console.warn('Git commit failed:', err?.message || err);
    // still allow the request to succeed; file is written already
  }
}

/* ------------ Paths ------------ */
function dayFile(slug) {
  assertDaySlug(slug);
  return safeJoin(DAYS_DIR, `${slug}.json`);
}
function photoInteractionsFile(photoId) {
  assertId(photoId, 'photoId');
  return safeJoin(INTERACTIONS_DIR, `${photoId}.json`);
}
function stackInteractionsFile(stackId) {
  assertId(stackId, 'stackId');
  return safeJoin(INTERACTIONS_DIR, `stack_${stackId}.json`);
}

/* ------------ Health ------------ */
app.get('/api/health', async () => ({ ok: true }));

/* ------------ Day JSON ------------ */
app.get('/api/day/:slug', async (req, reply) => {
  try {
    const filePath = dayFile(req.params.slug);
    const content = await fs.readFile(filePath, 'utf8');
    reply.type('application/json').send(JSON.parse(content));
  } catch (err) {
    reply.code(404).send({ error: 'Not found' });
  }
});

app.put('/api/day/:slug', async (req, reply) => {
  try {
    const slug = req.params.slug;
    assertDaySlug(slug);
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }
    const filePath = dayFile(slug);

    await withFileLock(filePath, async () => {
      await writeJsonAtomic(filePath, body);
      await gitStageCommitPush([filePath], `Update day ${slug}`);
    });

    reply.send({ ok: true });
  } catch (err) {
    req.log.error(err);
    reply.code(err.statusCode || 500).send({ error: err.message || 'Save failed' });
  }
});

/* ------------ Photo interactions ------------ */
app.get('/api/photo/:photoId/interactions', async (req, reply) => {
  try {
    const filePath = photoInteractionsFile(req.params.photoId);
    const interactions = await readJson(filePath, { reactions: {}, comments: [] });
    reply.send(interactions);
  } catch {
    reply.send({ reactions: {}, comments: [] });
  }
});

app.post('/api/photo/:photoId/react', async (req, reply) => {
  try {
    const photoId = req.params.photoId;
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });

    const filePath = photoInteractionsFile(photoId);

    const result = await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });

      const current = interactions.reactions[emoji] || 0;
      let removed = false;

      if (action === 'remove' || current > 0) {
        interactions.reactions[emoji] = Math.max(0, current - 1);
        if (interactions.reactions[emoji] === 0) delete interactions.reactions[emoji];
        removed = true;
      } else {
        interactions.reactions[emoji] = current + 1;
        removed = false;
      }

      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `React ${emoji} to photo ${photoId}`);

      return { count: interactions.reactions[emoji] || 0, removed };
    });

    reply.send({ ok: true, ...result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'react failed' });
  }
});

app.post('/api/photo/:photoId/comment', async (req, reply) => {
  try {
    const photoId = req.params.photoId;
    const { text, author } = req.body || {};
    if (!text || !String(text).trim()) return reply.code(400).send({ error: 'text required' });

    const filePath = photoInteractionsFile(photoId);

    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      timestamp: new Date().toISOString(),
    };

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      interactions.comments.push(comment);
      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Comment on photo ${photoId}`);
    });

    reply.send({ ok: true, comment });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'comment failed' });
  }
});

app.put('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    const { photoId, commentId } = req.params;
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return reply.code(400).send({ error: 'text required' });

    const filePath = photoInteractionsFile(photoId);

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      const comment = interactions.comments.find((c) => c.id === commentId);
      if (!comment) return reply.code(404).send({ error: 'comment not found' });

      comment.text = String(text).trim();
      comment.edited = new Date().toISOString();

      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Edit comment on photo ${photoId}`);
      reply.send({ ok: true, comment });
    });
  } catch (err) {
    req.log.error(err);
    if (!reply.sent) reply.code(500).send({ error: 'edit failed' });
  }
});

app.delete('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    const { photoId, commentId } = req.params;
    const filePath = photoInteractionsFile(photoId);

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      const index = interactions.comments.findIndex((c) => c.id === commentId);
      if (index === -1) return reply.code(404).send({ error: 'comment not found' });

      interactions.comments.splice(index, 1);
      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Delete comment on photo ${photoId}`);
      reply.code(204).send();
    });
  } catch (err) {
    req.log.error(err);
    if (!reply.sent) reply.code(500).send({ error: 'delete failed' });
  }
});

/* ------------ Stack interactions ------------ */
app.get('/api/stack/:stackId/interactions', async (req, reply) => {
  try {
    const stackId = req.params.stackId;
    const stackFile = stackInteractionsFile(stackId);
    const stackInteractions = await readJson(stackFile, { reactions: {}, comments: [] });

    // Roll-up mode
    if (req.query.includeRollup === 'true') {
      let photos = [];
      try {
        if (typeof req.query.photos === 'string') {
          photos = JSON.parse(req.query.photos);
        }
      } catch {
        // ignore bad JSON; treat as empty
      }

      // Ensure list contains only safe ids
      photos = Array.isArray(photos) ? photos.filter((id) => ID_RE.test(id)) : [];

      const totalReactions = { ...stackInteractions.reactions };
      let totalComments = [...(stackInteractions.comments || [])];

      for (const photoId of photos) {
        const pFile = photoInteractionsFile(photoId);
        const p = await readJson(pFile, { reactions: {}, comments: [] });

        for (const [emoji, count] of Object.entries(p.reactions || {})) {
          totalReactions[emoji] = (totalReactions[emoji] || 0) + (count || 0);
        }
        totalComments = totalComments.concat(p.comments || []);
      }

      return reply.send({
        stack: stackInteractions,
        rollup: {
          reactions: totalReactions,
          comments: totalComments,
          totalCommentCount: totalComments.length,
          totalReactionCount: Object.values(totalReactions).reduce((a, b) => a + b, 0),
        },
      });
    }

    reply.send(stackInteractions);
  } catch (err) {
    console.error('Error reading stack interactions:', err);
    reply.send({ reactions: {}, comments: [] });
  }
});

app.post('/api/stack/:stackId/react', async (req, reply) => {
  try {
    const stackId = req.params.stackId;
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });

    const filePath = stackInteractionsFile(stackId);

    const result = await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });

      const current = interactions.reactions[emoji] || 0;
      let removed = false;

      if (action === 'remove' || current > 0) {
        interactions.reactions[emoji] = Math.max(0, current - 1);
        if (interactions.reactions[emoji] === 0) delete interactions.reactions[emoji];
        removed = true;
      } else {
        interactions.reactions[emoji] = current + 1;
      }

      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `React to stack ${stackId} with ${emoji}`);

      return { count: interactions.reactions[emoji] || 0, removed };
    });

    reply.send({ ok: true, ...result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'react failed' });
  }
});

app.post('/api/stack/:stackId/comment', async (req, reply) => {
  try {
    const stackId = req.params.stackId;
    const { text, author } = req.body || {};
    if (!text || !String(text).trim()) return reply.code(400).send({ error: 'text required' });

    const filePath = stackInteractionsFile(stackId);
    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      timestamp: new Date().toISOString(),
    };

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      interactions.comments.push(comment);
      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Comment on stack ${stackId}`);
    });

    reply.send({ ok: true, comment });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'comment failed' });
  }
});

app.put('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    const { stackId, commentId } = req.params;
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return reply.code(400).send({ error: 'text required' });

    const filePath = stackInteractionsFile(stackId);

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      const comment = interactions.comments.find((c) => c.id === commentId);
      if (!comment) return reply.code(404).send({ error: 'comment not found' });

      comment.text = String(text).trim();
      comment.edited = new Date().toISOString();

      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Edit comment on stack ${stackId}`);
      reply.send({ ok: true, comment });
    });
  } catch (err) {
    req.log.error(err);
    if (!reply.sent) reply.code(500).send({ error: 'edit failed' });
  }
});

app.delete('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    const { stackId, commentId } = req.params;
    const filePath = stackInteractionsFile(stackId);

    await withFileLock(filePath, async () => {
      const interactions = await readJson(filePath, { reactions: {}, comments: [] });
      const index = interactions.comments.findIndex((c) => c.id === commentId);
      if (index === -1) return reply.code(404).send({ error: 'comment not found' });

      interactions.comments.splice(index, 1);
      await writeJsonAtomic(filePath, interactions);
      await gitStageCommitPush([filePath], `Delete comment on stack ${stackId}`);
      reply.code(204).send();
    });
  } catch (err) {
    req.log.error(err);
    if (!reply.sent) reply.code(500).send({ error: 'delete failed' });
  }
});

/* ------------ Start ------------ */
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => app.log.info(`Travel-share backend running at ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
