# FindPenguin Travel Blog & Tracker

A static travel blog system that lets you share GPS tracks, curated photos, and diary entries with friends and family. Built with a public viewer site and private admin interface.

## 🎯 What This System Does

### For Your Audience (Public Site)
- **Trip Overview**: Map with all your routes, photo highlights, and day cards
- **Daily Pages**: Interactive maps with GPS tracks, time slider, and photo galleries  
- **Photo Interactions**: Like, react with emojis, and comment on photos
- **Diary/Blog**: Read your travel stories and daily experiences
- **Mobile Friendly**: Works on phones, tablets, and desktops

### For You (Admin Interface)
- **Import Trips**: Pull GPS tracks from Dawarich and photos from Immich automatically
- **Curate Content**: Drag-and-drop photo ordering, edit captions, set cover images
- **Write Stories**: Markdown editor with live preview for blog posts and diary entries
- **Preview & Publish**: See exactly how content will look before making it public
- **Multi-User Photos**: Import from multiple Immich users (family members)

## 📁 Project Structure

```
FindPenguin/
├── README.md                 # This file
├── package.json             # Backend dependencies (Fastify, marked, etc.)
├── server.js                # Backend API (handles saving, git commits)
├── docker-compose.yml       # Run everything with one command
└── public/                  # Static site (what visitors see)
    ├── index.html           # Homepage with trip overview
    ├── day.html             # Individual day pages
    ├── css/styles.css       # All styling
    ├── js/
    │   ├── day.js          # Day page logic (map, slider, photos)
    │   └── index.js        # Homepage logic (overview map)
    ├── days/
    │   ├── index.json      # List of published days
    │   └── 2025-08-14.json # Example day data (tracks, photos, stats)
    ├── blog/
    │   ├── index.json      # Blog post index
    │   ├── index.html      # Blog listing page
    │   └── *.html          # Individual blog posts
    └── admin/
        ├── index.html      # Admin interface
        └── admin.js        # Admin logic (Trips, Blog, Settings tabs)
```

## 🗂 Asset Caching and CDN

Static files in `public/` are served with a long cache lifetime (`maxAge` of 1 year).
To ensure browsers receive updates when files change, the server appends a content hash
to asset URLs (e.g. `/js/index.js?v=abcd1234`).

If you host assets behind a CDN, set the `CDN_URL` environment variable. When provided,
all static paths are rewritten to use the CDN domain while retaining the hash query
parameter.

## 🚀 How to Run

### Option A: Local Development (Your Laptop)

1. **Start the frontend** (serves the website):
   ```bash
   cd FindPenguin/public
   python3 -m http.server 8000
   ```
   Open http://localhost:8000

2. **Start the backend** (in a new terminal):
   ```bash
   cd FindPenguin
   npm install
   PORT=4000 \
   REPO_DIR=$(pwd) \
   GIT_USER_NAME="Your Name" \
   GIT_USER_EMAIL="you@example.com" \
   node server.js
   ```

   The backend relies on several Node packages, including
   [`@fastify/compress`](https://www.npmjs.com/package/@fastify/compress) for
   response compression and [`exifr`](https://www.npmjs.com/package/exifr) for
   reading EXIF metadata. Running `npm install` will install these
   dependencies automatically as defined in `package.json`.

3. **Configure the admin**:
   - Open http://localhost:8000/admin/index.html
   - Enter any password (stored locally)
   - Settings tab → Backend API Base URL: `http://localhost:4000`

### Option B: Docker Compose (Recommended for NAS)

1. **Create docker-compose.yml** in your project root:
   ```yaml
   version: "3.9"
   services:
     travel-site:
       image: nginx:alpine
       container_name: travel-site
       ports:
         - "8080:80"
       volumes:
         - ./public:/usr/share/nginx/html:ro
     
     travel-api:
       image: node:20-alpine
       container_name: travel-api
       working_dir: /app
       command: |
         sh -c "
           npm install &&
           PORT=4000 \
           REPO_DIR=/app \
           GIT_USER_NAME='Your Name' \
           GIT_USER_EMAIL='you@example.com' \
           node server.js
         "
       ports:
         - "4000:4000"
       volumes:
         - ./:/app
   ```

2. **Run everything**:
   ```bash
   docker compose up -d
   ```

3. **Access**:
   - Public site: http://truenas.local:8080
   - Admin: http://truenas.local:8080/admin/index.html
   - In Settings: Backend API Base URL = `http://truenas.local:4000`

## ⚙️ Configuration
### EXIF Metadata

Local media import uses the [`exifr`](https://www.npmjs.com/package/exifr) library to read timestamps and GPS coordinates from image and video files. Run `npm install` to install dependencies. Files without EXIF data fall back to file modification time and omit location.


### Connect to Your Existing Services

The admin interface can import data from your existing setup:

1. **Open Admin → Settings tab**

2. **Immich Configuration**:
   - URLs (comma-separated if multiple): `https://immich-one, https://immich-two`
   - Tokens: One API key per line (for each server/user)
   - Create an album called "Public-Trip" and add only photos you want to share

3. **Dawarich Configuration**:
   - URL: `https://your-dawarich-url`
   - Token: Your Dawarich API token

4. **Backend API**:
   - Set to where your backend runs (e.g., `http://localhost:4000` or `http://truenas.local:4000`)

### CORS Setup
Since the admin calls your Immich/Dawarich directly, enable CORS on both:
- Immich: Set `ENABLE_CORS=true` in environment
- Dawarich: Enable CORS in configuration

### Immich Album & Auto-Loader

- `IMMICH_URLS` and `IMMICH_API_KEYS`: comma-separated lists of server URLs and API keys.
  - Use a single URL with multiple keys to import from multiple users on one server.
  - Provide matching counts of URLs and keys to pull from several servers.
  - Inline comments after `#` are ignored, allowing you to annotate entries.
- `IMMICH_ALBUM_ID` (optional): limit imports to a single Immich album. Leave unset to scan all assets visible to your API keys.
- The auto-loader groups assets by the day they were taken and writes JSON files like `public/data/days/2025-08-14.json`.
- Scheduling: there is no built-in scheduler. Run the loader manually or via an external cron job; each run processes one day and will overwrite that day's file on subsequent runs.
- `ADMIN_TOKEN` (optional): protects admin endpoints. If set, the import button and other admin actions send this token in an `x-admin-token` header.
  - `LOCAL_MEDIA_DIR` (optional): absolute path to a folder of synced media. When set, imported photos point to `/media/` URLs instead of proxying through Immich.
  - `LOCAL_THUMB_DIR` (optional): directory for generated thumbnails. Defaults to `<LOCAL_MEDIA_DIR>/thumbs` and uses [`sharp`](https://sharp.pixelplumbing.com/).

Minimal `.env` example:

```env
# Single Immich server with two user API keys
IMMICH_URLS=https://photos.example.com
IMMICH_API_KEYS=user_one_key,user_two_key # comments after # are allowed
IMMICH_ALBUM_ID=your_album_id
ADMIN_TOKEN=changeme # required for admin actions like importing
ANON_COOKIE_SECRET=long_random_string
LOCAL_MEDIA_DIR=/srv/immich-album
LOCAL_THUMB_DIR=/srv/immich-album-temp

# Or multiple servers:
# IMMICH_URLS=https://immich-one.example.com,https://immich-two.example.com
# IMMICH_API_KEYS=key_for_one,key_for_two
```

Running the loader for `2025-08-14` with the above settings creates `public/data/days/2025-08-14.json` containing only photos from the specified album.

After syncing new files into `LOCAL_MEDIA_DIR`, rerun the admin import so the generated day JSON files reference the local `/media/` paths and regenerate thumbnails in `LOCAL_THUMB_DIR`.

## 📝 Daily Workflow

### Creating a Trip Day

1. **Open Admin** → Trips tab
2. **Pick a date** and click **Import**
   - Automatically loads GPS track from Dawarich
   - Fetches photos from all configured Immich users
3. **Curate content**:
   - Uncheck photos you don't want to share
   - Drag and drop to reorder
   - Double-click photos to edit captions or set as cover
4. **Preview** to see exactly how it will look
5. **Save** - backend commits changes to git

### Writing Blog Posts

1. **Admin** → Blog tab
2. **New Post** or click existing post to edit
3. **Write in Markdown** with live HTML preview
4. **Save** - automatically converts to HTML and updates blog index

### Publishing
- Every Save automatically commits to your git repository
- If connected to Vercel/Netlify, changes deploy automatically
- Friends and family see updates on your public URL

## 🛠 What We Built & Why

### Architecture Decisions

**Static Site + API Backend**
- **Why**: Extremely fast loading, works offline, easy to host anywhere
- **Public site**: Pure HTML/CSS/JS, no server required
- **Admin interface**: Talks to lightweight API for file operations

**File-Based Storage**
- **Why**: Simple, portable, version controlled, no database maintenance
- **JSON files**: Store day data, photo metadata, blog index
- **Git commits**: Every change is tracked and backed up

**Browser-Based Admin**
- **Why**: Works on any device, no software to install
- **Responsive**: Edit from phone, tablet, or desktop
- **Live preview**: See changes before publishing

### Technology Choices

**Frontend**:
- **Leaflet**: Maps without vendor lock-in, works offline
- **Vanilla JS**: No framework dependencies, fast loading
- **CSS Grid/Flexbox**: Modern responsive design

**Backend**:
- **Fastify**: Lightweight, fast API server
- **marked**: Markdown to HTML conversion
- **simple-git**: Automated git operations

**Integration**:
- **Immich API**: Photo management and multi-user support
- **Dawarich API**: GPS track import
- **GitHub**: Private repository with public deployment

## 🎯 Next Steps & Priorities

### Immediate Priorities

1. **Test the Full Workflow**
   - Import a real day's data
   - Curate photos and write a blog post
   - Verify git commits are working
   - Check public site updates

2. **Set Up Deployment**
   - Connect your private GitHub repo to Vercel/Netlify
   - Configure automatic deployments on git push
   - Set up custom domain (optional)

### Phase 2 Enhancements

3. **Image Optimization** ⭐ High Impact
   - **What**: Automatically resize photos and strip EXIF data
   - **Why**: Faster loading, privacy protection, smaller git repo
   - **How**: Backend downloads originals from Immich, creates 400px/1600px versions

4. **Authentication** ⭐ Important for Security
   - **What**: Password protect the admin interface
   - **Why**: Prevent unauthorized access to your editing tools
   - **How**: Simple HTTP Basic Auth or JWT tokens

5. **Draft vs. Publish Workflow**
   - **What**: Work on days privately before making them public
   - **Why**: Preview and perfect content before sharing
   - **How**: Separate draft storage, publish button moves to public

### Phase 3 Nice-to-Haves

6. **Enhanced Photo Features**
   - Bulk import from specific albums
   - Photo location verification
   - Automatic caption suggestions

7. **Social Features**
   - Email notifications when new content is published
   - RSS/Atom feed for followers
   - Print-friendly day summaries

8. **Advanced Mapping**
   - Elevation profiles
   - Multiple track types (hiking, driving, cycling)
   - Interactive waypoint markers

## 🔧 Troubleshooting

### Common Issues

**Admin shows "Folder access is required"**
- Only appears in Firefox/Safari
- Use Chrome/Edge/Brave for File System Access API
- Or run the Docker setup (no folder picker needed)

**Import fails with CORS errors**
- Enable CORS on Immich: `ENABLE_CORS=true`
- Enable CORS on Dawarich in its configuration
- Check browser console for specific error messages

**Backend connection fails**
- Verify backend is running: `http://localhost:4000/api/blog`
- Check Settings → Backend API Base URL matches server location
- Ensure firewall allows port 4000

**Git commits not working**
- Verify Git user name and email are set
- Check repository has correct remote URL
- Ensure GitHub token has repository write permissions

### Getting Help

1. **Check browser console** for JavaScript errors
2. **Check backend logs** for API errors
3. **Verify API endpoints** respond correctly:
   - `http://localhost:4000/api/blog` (should return array)
   - `http://localhost:4000/api/day/2025-08-14` (should return JSON or 404)

## 🎉 Success Metrics

You'll know everything is working when:

✅ Admin imports tracks and photos successfully  
✅ Photo curation (reorder, caption, cover) saves properly  
✅ Blog posts render with live Markdown preview  
✅ Public site shows your content beautifully  
✅ Friends can view, react, and comment on photos  
✅ Git commits happen automatically on every save  
✅ Public site updates when you push changes  

## 📄 License & Usage

This is your personal travel sharing system. Customize, modify, and share as needed. The codebase is designed to be understandable and maintainable without deep programming knowledge.

**Key principle**: Everything should "just work" once configured, requiring minimal technical maintenance while you focus on creating and sharing amazing travel content.
