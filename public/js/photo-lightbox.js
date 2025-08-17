// --- Lightweight lightbox with per-photo interactions ---
window.openPhotoLightbox = (photos, startIndex=0) => {
  let i = startIndex;

  // build once
  let el = document.querySelector(".lb-portal");
  if (!el) {
    el = document.createElement("div");
    el.className = "lb-portal";
    el.innerHTML = `
      <div class="lb-backdrop"></div>
      <div class="lb-frame" role="dialog" aria-modal="true">
        <button class="lb-close" aria-label="Close">✕</button>
        <img class="lb-img" alt="">
        <button class="lb-nav lb-prev" aria-label="Prev">‹</button>
        <button class="lb-nav lb-next" aria-label="Next">›</button>

        <div class="lb-rail">
          <button class="lb-like"><span>♥</span> <b class="lb-like-count">0</b></button>
          <div class="lb-comments">
            <div class="lb-comments-list"></div>
            <div class="lb-compose">
              <input class="lb-input" placeholder="Comment…" />
              <button class="lb-post">Post</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    el.querySelector(".lb-backdrop").onclick =
    el.querySelector(".lb-close").onclick = () => el.classList.remove("on");

    el.querySelector(".lb-prev").onclick = () => show(i-1);
    el.querySelector(".lb-next").onclick = () => show(i+1);
    document.addEventListener("keydown", (e)=>{
      if (!el.classList.contains("on")) return;
      if (e.key==="Escape") el.classList.remove("on");
      if (e.key==="ArrowLeft") show(i-1);
      if (e.key==="ArrowRight") show(i+1);
    });
  }

  const img = el.querySelector(".lb-img");
  const likeBtn = el.querySelector(".lb-like");
  const likeCount = el.querySelector(".lb-like-count");
  const list = el.querySelector(".lb-comments-list");
  const input = el.querySelector(".lb-input");
  const post = el.querySelector(".lb-post");

  async function hydrate(photo) {
    const data = await fetchPhotoInteractions(photo.id);
    const count = Object.values(data.reactions || {}).reduce((a,b)=>a+b,0);
    likeCount.textContent = count;

    const key = `liked:photo:${photo.id}`;
    let liked = localStorage.getItem(key) === "1";
    paintLiked();

    likeBtn.onclick = async () => {
      const r = await reactPhoto(photo.id, liked);
      if (r?.ok) {
        liked = !liked; localStorage.setItem(key, liked ? "1" : "");
        likeCount.textContent = r.count ?? likeCount.textContent;
        paintLiked();
      }
    };
    function paintLiked(){ likeBtn.classList.toggle("liked", liked); }

    list.innerHTML = (data.comments || []).slice(-30).map(c=>`
      <div class="comment-item">
        <div class="comment-author">${c.author || "Anon"}</div>
        <div class="comment-text">${(c.text||"").replace(/</g,"&lt;")}</div>
        <div class="comment-time">${new Date(c.timestamp||Date.now()).toLocaleString()}</div>
      </div>
    `).join("");

    post.onclick = async () => {
      const t = input.value.trim(); if (!t) return;
      const c = await commentPhoto(photo.id, t);
      if (c) {
        list.insertAdjacentHTML("beforeend", `
          <div class="comment-item">
            <div class="comment-author">${c.author}</div>
            <div class="comment-text">${c.text.replace(/</g,"&lt;")}</div>
            <div class="comment-time">${new Date(c.timestamp).toLocaleString()}</div>
          </div>
        `);
        input.value = "";
      }
    };
  }

  function show(next) {
    i = (next + photos.length) % photos.length;
    const p = photos[i];
    img.src = p.url;
    hydrate(p);
    el.querySelector(".lb-prev").disabled = photos.length < 2;
    el.querySelector(".lb-next").disabled = photos.length < 2;
  }

  show(i);
  el.classList.add("on");
};