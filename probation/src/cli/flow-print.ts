// flow-print — prints the Undertaker flow definition for pasting into GitLab (AI > Flows > New flow).
import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { main } from './common.ts';

main(async () => {
  const item = parse(readFileSync('flows/undertaker.yml', 'utf8')) as { definition: unknown };
  process.stdout.write(stringify(item.definition));
});
