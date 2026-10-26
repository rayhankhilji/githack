import { buildServer } from './server.ts';

const { app } = buildServer({ apiKey: process.env.TALLYBOOK_API_KEY });
const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: '0.0.0.0' }).catch((error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
