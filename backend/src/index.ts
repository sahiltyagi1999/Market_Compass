import { config } from 'dotenv';
import { app } from './app.js';

config({ path: new URL('../../.env', import.meta.url) });

const port = Number(process.env.PORT || 4100);
app.listen(port, '0.0.0.0', () => console.log(`MarketCompass API listening on port ${port}`));
