import { readFileSync } from 'node:fs';
import { searchFlights, planSearch } from '../search';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: npm run --silent search -- [--plan] [request.json|-]\nInput: JSON file or stdin. Output: one JSON object. Exit 2: invalid input; 3: no usable offers.\n');
    return;
  }
  const planOnly = args.includes('--plan');
  const paths = args.filter(a => a !== '--plan');
  if (paths.length > 1 || paths.some(a => a.startsWith('--'))) throw new TypeError('Expected one JSON path, stdin (-), or --plan');
  const text = readFileSync(!paths.length || paths[0] === '-' ? 0 : paths[0], 'utf8');
  if (Buffer.byteLength(text) > 1_048_576) throw new TypeError('Input exceeds 1 MiB');
  const request = JSON.parse(text);
  const result = planOnly ? planSearch(request) : await searchFlights(request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!planOnly && ['error', 'empty'].includes((result as any).status)) process.exitCode = 3;
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ schema_version: '1.0', status: 'error', error: {
    code: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error),
  } })}\n`);
  process.exitCode = 2;
});
