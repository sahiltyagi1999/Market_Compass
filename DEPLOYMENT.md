# Deployment

The frontend is configured for Netlify and the Express API for Render.

## Render backend

Create a Blueprint from the repository's `render.yaml`. During initial setup, Render prompts for variables marked `sync: false`.

Required values:

```env
FRONTEND_ORIGIN=https://your-site.netlify.app
UPSTOX_ANALYTICS_TOKEN=your_rotated_token
OPENAI_API_KEY=your_rotated_key
```

`COINGECKO_DEMO_API_KEY` is optional. Never commit any of these values.

After deployment, verify:

```text
https://your-api.onrender.com/api/health
```

## Netlify frontend

Set this environment variable to the deployed Render origin, without a trailing slash:

```env
VITE_API_BASE_URL=https://your-api.onrender.com
```

Netlify reads `netlify.toml`, builds the frontend workspace, and publishes `frontend/dist`.

## Production notes

- Update Render's `FRONTEND_ORIGIN` if the final Netlify URL changes.
- Multiple allowed origins can be comma-separated.
- Render's free filesystem is ephemeral, so local prediction-history records can reset after restarts or redeploys.
- Free Render services can cold-start after inactivity.
