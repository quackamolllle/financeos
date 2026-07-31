# FinanceOS Deployment Guide (Free Service)

Since FinanceOS uses a local SQLite database (`financeos.db`), deploying it to a traditional free host like Heroku or Render (Free Tier) will cause your database to be wiped every time the server restarts or goes to sleep.

To deploy this app for **free** while keeping your data safe and persistent, **Fly.io** is the best option because they offer a free tier that includes persistent storage volumes.

## Option: Deploying to Fly.io

### Prerequisites
1. Create an account at [Fly.io](https://fly.io/)
2. Install the `flyctl` command line tool on your machine:
   - Mac: `brew install flyctl`
   - Windows: `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`
   - Linux: `curl -L https://fly.io/install.sh | sh`
3. Log in via your terminal: `fly auth login`

### Step 1: Initialize the App
Open your terminal in the FinanceOS folder and run:
```bash
fly launch
```
- It will ask if you want to tweak the settings. Say **Yes**.
- Set the App Name (or leave it blank for a random one).
- Choose a region close to you.
- **IMPORTANT**: When it asks to set up a database (Postgres/Redis), say **No**.

### Step 2: Create a Persistent Volume
To make sure your SQLite database doesn't get deleted, you need a volume.
```bash
fly volumes create financeos_data --region <your-region> --size 1
```
*(1GB is plenty for this app and fits well within the free tier).*

### Step 3: Configure `fly.toml`
Open the `fly.toml` file that was generated in your project folder, and add the `[mounts]` section at the end so it knows where to attach the volume:

```toml
[mounts]
  source = "financeos_data"
  destination = "/app/data"
```

### Step 4: Add a Start Script
Ensure your `package.json` has a `start` script:
```json
"scripts": {
  "start": "node server.js"
}
```

### Step 5: Deploy
Run the following command to deploy your app:
```bash
fly deploy
```

Once it's done, you can open your live app:
```bash
fly open
```

---

## Alternative: Local Home Server (e.g., Raspberry Pi)
If you don't want your financial data on the cloud, FinanceOS is completely self-contained. You can run it on a Raspberry Pi or an old laptop on your home network:
1. Install Node.js on the device.
2. Clone this folder to the device.
3. Run `npm install` and `npm start`.
4. Access it from any device in your house via `http://<device-ip>:3000`.
