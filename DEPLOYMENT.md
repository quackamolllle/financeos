# Deploying FinanceOS for Free

FinanceOS is a lightweight Node.js application that uses **SQLite** for its database. Because SQLite stores data in a local file (`finance.db`), your deployment host must provide **persistent storage** (a disk that doesn't get wiped when the server restarts). 

Here are the two best options for deploying FinanceOS completely for free while keeping your data safe.

---

## Option 1: Fly.io (Recommended)
Fly.io offers a generous free tier that includes up to 3GB of persistent storage, which is perfect for our SQLite database.

### Prerequisites
1. Sign up for a free account at [fly.io](https://fly.io)
2. Install the `flyctl` command-line tool on your computer.

### Deployment Steps
1. Open your terminal in the FinanceOS folder.
2. Run `fly launch`.
   - Choose a name for your app (or let it auto-generate).
   - Choose a region close to you.
   - When asked to setup a database, say **No** (we use SQLite).
   - When asked to deploy now, say **No**.
3. Create a persistent volume for the database:
   ```bash
   fly volumes create financeos_data --size 1
   ```
4. Edit the generated `fly.toml` file to mount the volume. Add this section to the end of the file:
   ```toml
   [mounts]
     source = "financeos_data"
     destination = "/data"
   ```
5. Update `server.js` to use the new volume path. Change line 14 from:
   `const DB_FILE = process.env.DB_FILE || 'finance.db';`
   To:
   `const DB_FILE = process.env.DB_FILE || '/data/finance.db';`
6. Deploy your app!
   ```bash
   fly deploy
   ```
Your app will be live at `https://your-app-name.fly.dev`!

---

## Option 2: Render.com (Requires a small code change)
Render has a great free tier for hosting Node apps, but their free servers have *ephemeral* storage (the disk resets on every deploy or restart, wiping your SQLite database). 

To use Render for free, you must switch from SQLite to **PostgreSQL** (Render provides a free Postgres database).

### Deployment Steps
1. Sign up at [render.com](https://render.com) and create a **Free PostgreSQL** database.
2. In your FinanceOS code, run `npm install pg` to install the Postgres driver.
3. Update `server.js` to connect to Postgres instead of SQLite (using the `pg` package).
4. Push your code to GitHub.
5. Create a **New Web Service** on Render, connect your GitHub repo, and set the Build Command to `npm install` and the Start Command to `npm start`.
6. Add the `DATABASE_URL` environment variable to your Render Web Service, copying the Internal Database URL from your new Postgres instance.

---

## Security Warning
FinanceOS is currently designed as a **single-user, self-hosted** application. It does not have a login screen or authentication built-in. 

**If you deploy this to the public internet, anyone who finds the URL can see and edit your financial data.**

Before deploying to a public service, it is highly recommended to add basic authentication. You can do this easily by adding the `express-basic-auth` package to `server.js`:

```javascript
const basicAuth = require('express-basic-auth');

app.use(basicAuth({
    users: { 'admin': 'your-secret-password' },
    challenge: true
}));
```
