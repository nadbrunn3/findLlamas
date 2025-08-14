import fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';
import dotenv from 'dotenv';
import { marked } from 'marked';

dotenv.config();

const PORT = process.env.PORT || 4000;
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const DAYS_DIR = path.join(REPO_DIR, 'public', 'days');
const BLOG_DIR = path.join(REPO_DIR, 'public', 'blog');
const BLOG_INDEX = path.join(BLOG_DIR, 'index.json');
const INTERACTIONS_DIR = path.join(REPO_DIR, 'public', 'interactions');

const git = simpleGit(REPO_DIR);

const app = fastify({ logger: true });
app.register(cors, { origin: true });

async function readJson(filePath, def=[]) {
  try { const txt = await fs.readFile(filePath,'utf8'); return JSON.parse(txt);}catch{return def;}
}

async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath),{recursive:true});
  await fs.writeFile(filePath, JSON.stringify(obj,null,2));
}

// Helper to resolve file path safely
function dayFile(slug) {
  return path.join(DAYS_DIR, `${slug}.json`);
}

// GET day JSON
app.get('/api/day/:slug', async (req, reply) => {
  try {
    const filePath = dayFile(req.params.slug);
    const content = await fs.readFile(filePath, 'utf8');
    reply.type('application/json').send(JSON.parse(content));
  } catch (err) {
    reply.code(404).send({ error: 'Not found' });
  }
});

// PUT day JSON (save & commit)
app.put('/api/day/:slug', async (req, reply) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }
    const filePath = dayFile(req.params.slug);
    await fs.mkdir(DAYS_DIR, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(body, null, 2));

    const commitMessage = `Update day ${req.params.slug}`;
    await git.add([filePath]);
    await git.commit(commitMessage);
    if (process.env.GIT_PUSH !== 'false') {
      await git.push();
    }
    reply.send({ ok: true });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'Save failed' });
  }
});

// ---- BLOG ENDPOINTS ----

// GET list
app.get('/api/blog', async (req, reply)=>{
  const list = await readJson(BLOG_INDEX, []);
  reply.send(list);
});

// GET markdown for a post
app.get('/api/blog/:slug', async (req, reply)=>{
  try {
    const mdPath = path.join(BLOG_DIR, req.params.slug + '.md');
    const md = await fs.readFile(mdPath,'utf8');
    const list = await readJson(BLOG_INDEX, []);
    const meta = list.find(p=>p.slug===req.params.slug) || {};
    reply.send({ markdown: md, title: meta.title||'', date: meta.date||'' });
  } catch(err) {
    reply.code(404).send({error:'not found'});
  }
});

// PUT post (markdown) {title,date,markdown,excerpt}
app.put('/api/blog/:slug', async (req, reply)=>{
  try {
    const { title, date, markdown } = req.body||{};
    if(!title || !date || !markdown) return reply.code(400).send({error:'missing fields'});
    const slug = req.params.slug;

    // write markdown
    await fs.mkdir(BLOG_DIR,{recursive:true});
    const mdPath = path.join(BLOG_DIR, slug + '.md');
    await fs.writeFile(mdPath, markdown);

    // convert to HTML
    const html = marked.parse(markdown);
    await fs.writeFile(path.join(BLOG_DIR, slug + '.html'), html);

    // update index.json
    const excerpt = markdown.split('\n')[0].slice(0,120);
    const list = await readJson(BLOG_INDEX, []);
    const existing = list.find(p=>p.slug===slug);
    if(existing){
      existing.title = title; existing.date=date; existing.excerpt=excerpt;
    } else {
      list.unshift({slug,title,date,excerpt});
    }
    await writeJson(BLOG_INDEX, list);

    // git commit
    await git.add([mdPath, path.join(BLOG_DIR, slug+'.html'), BLOG_INDEX]);
    await git.commit(`Blog post ${slug}`);
    if(process.env.GIT_PUSH!=='false') await git.push();

    reply.send({ok:true});
  }catch(err){req.log.error(err);reply.code(500).send({error:'save failed'});}
});

// ---- PHOTO INTERACTIONS ENDPOINTS ----

// GET interactions for a photo
app.get('/api/photo/:photoId/interactions', async (req, reply)=>{
  try {
    const photoId = req.params.photoId;
    const interactionsPath = path.join(INTERACTIONS_DIR, photoId + '.json');
    const interactions = await readJson(interactionsPath, {reactions:{}, comments:[]});
    reply.send(interactions);
  } catch(err) {
    reply.send({reactions:{}, comments:[]});
  }
});

// POST reaction to a photo
app.post('/api/photo/:photoId/react', async (req, reply)=>{
  try {
    const photoId = req.params.photoId;
    const { emoji } = req.body || {};
    if (!emoji) return reply.code(400).send({error:'emoji required'});
    
    const interactionsPath = path.join(INTERACTIONS_DIR, photoId + '.json');
    const interactions = await readJson(interactionsPath, {reactions:{}, comments:[]});
    
    interactions.reactions[emoji] = (interactions.reactions[emoji] || 0) + 1;
    
    await writeJson(interactionsPath, interactions);
    await git.add([interactionsPath]);
    await git.commit(`React ${emoji} to photo ${photoId}`);
    if(process.env.GIT_PUSH!=='false') await git.push();
    
    reply.send({ok:true, count: interactions.reactions[emoji]});
  }catch(err){req.log.error(err);reply.code(500).send({error:'react failed'});}
});

// POST comment to a photo
app.post('/api/photo/:photoId/comment', async (req, reply)=>{
  try {
    const photoId = req.params.photoId;
    const { text, author } = req.body || {};
    if (!text) return reply.code(400).send({error:'text required'});
    
    const interactionsPath = path.join(INTERACTIONS_DIR, photoId + '.json');
    const interactions = await readJson(interactionsPath, {reactions:{}, comments:[]});
    
    const comment = {
      id: Date.now().toString(),
      text: text.trim(),
      author: author || 'Anonymous',
      timestamp: new Date().toISOString()
    };
    
    interactions.comments.push(comment);
    
    await writeJson(interactionsPath, interactions);
    await git.add([interactionsPath]);
    await git.commit(`Comment on photo ${photoId}`);
    if(process.env.GIT_PUSH!=='false') await git.push();
    
    reply.send({ok:true, comment});
  }catch(err){req.log.error(err);reply.code(500).send({error:'comment failed'});}
});

app.listen(PORT, '0.0.0.0', (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Travel-share backend running at ${address}`);
});
