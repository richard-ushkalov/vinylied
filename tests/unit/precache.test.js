import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { shellFiles } from '../../tools/precache.mjs';

test('sw.js кеширует всё, что нужно без сети (npm run precache)', async () => {
    const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
    const block = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';
    const listed = [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);
    assert.deepEqual(listed, await shellFiles());
});
