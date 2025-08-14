// public/blog/blog.js
async function loadPosts() {
  try {
    const res = await fetch('index.json');
    const posts = await res.json();
    const list = document.getElementById('posts-list');
    posts.forEach(post => {
      const a = document.createElement('a');
      a.href = post.slug + '.html';
      a.className = 'card';
      a.innerHTML = `
        <h3>${post.title}</h3>
        <p style="opacity:0.8; font-size:0.9rem;">${post.date}</p>
        <p>${post.excerpt}</p>
      `;
      list.appendChild(a);
    });
  } catch (err) {
    console.error('Failed to load posts index', err);
  }
}
loadPosts();
