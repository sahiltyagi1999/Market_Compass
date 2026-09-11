# Deploy Netlify + Render

Repository: `https://github.com/sahiltyagi1999/Market_Compass`

The frontend is configured for Netlify with `netlify.toml`. The Express API is configured for Render with `render.yaml`. Do not put tokens in either file.

## 1. Deploy the frontend shell on Netlify

1. Open Netlify and select **Add new project > Import an existing project**.
2. Choose GitHub and select `sahiltyagi1999/Market_Compass`.
3. Netlify should read these values from `netlify.toml`:

```text
Build command: npm run build -w frontend
Publish directory: frontend/dist
Node version: 22.22.0
```

4. Deploy without adding `VITE_API_BASE_URL` yet.
5. Copy the generated URL, for example `https://your-site.netlify.app`.

The first frontend deployment will show an API error until steps 2 and 3 are complete. This is expected.

## 2. Deploy the backend with a Render Blueprint

1. Open Render and select **New > Blueprint**.
2. Connect `sahiltyagi1999/Market_Compass`.
3. Render detects the root `render.yaml`; select the `main` branch and apply it.
4. Enter these secret environment variables when prompted:

```env
FRONTEND_ORIGIN=https://your-site.netlify.app
UPSTOX_ANALYTICS_TOKEN=your_rotated_upstox_token
OPENAI_API_KEY=your_rotated_openai_key
```

Use the exact Netlify origin with no trailing slash. The instrument keys and OpenAI model are already non-secret Blueprint values.

5. Wait for the `market-compass-india-api` service to become **Live**.
6. Open its health endpoint:

```text
https://your-api.onrender.com/api/health
```

The response should report `ok`, `hasUpstoxToken`, and `hasOpenAIKey` as `true`.

## 3. Connect Netlify to Render

1. In Netlify open **Project configuration > Environment variables**.
2. Add:

```env
VITE_API_BASE_URL=https://your-api.onrender.com
```

3. Open **Deploys** and select **Trigger deploy > Deploy project without cache**.
4. Open the Netlify URL and confirm Nifty, Bitcoin, and News load.

## Optional CoinGecko key

The public crypto feed works without a key. For more stable limits, add `COINGECKO_DEMO_API_KEY` manually in the Render service environment and redeploy.

## Production notes

- If the Netlify domain changes, update Render's `FRONTEND_ORIGIN` and redeploy.
- Multiple allowed frontend origins can be comma-separated.
- Render free services can cold-start after inactivity.
- Render's free filesystem is ephemeral, so the local prediction-history file can reset after restarts or deploys.
- Rotate the Upstox and OpenAI credentials that were previously exposed before adding them to Render.
