import { config } from 'dotenv';

config({ path: new URL('../../.env', import.meta.url) });

const { app } = await import('./app.js');
const port = Number(process.env.PORT || 4100);
app.listen(port, '0.0.0.0', () => console.log(`MarketCompass API listening on port ${port}`));
