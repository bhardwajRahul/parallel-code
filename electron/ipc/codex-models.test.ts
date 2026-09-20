import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ warn: vi.fn() }));

import { listCodexModels } from './codex-models.js';

let home: string;
const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeCache(contents: unknown): void {
  fs.writeFileSync(
    path.join(home, 'models_cache.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

describe('listCodexModels', () => {
  it('keeps the listed models in cache order and drops hidden ones', () => {
    writeCache({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
      ],
    });

    expect(listCodexModels()).toEqual([
      { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
      { slug: 'gpt-5.5', displayName: 'GPT-5.5' },
    ]);
  });

  it('drops entries whose slug could not be a CLI argument and names the rest by slug', () => {
    writeCache({
      models: [
        { slug: '-- rm -rf', display_name: 'Injected', visibility: 'list' },
        { slug: 'GPT-Upper', display_name: 'Upper case', visibility: 'list' },
        { slug: 42, display_name: 'Not a string', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        'not an object',
      ],
    });

    expect(listCodexModels()).toEqual([{ slug: 'gpt-5.5', displayName: 'gpt-5.5' }]);
  });

  it('returns nothing when the cache is missing, malformed or not a model list', () => {
    expect(listCodexModels()).toEqual([]);

    writeCache('{ not json');
    expect(listCodexModels()).toEqual([]);

    writeCache({ models: 'all of them' });
    expect(listCodexModels()).toEqual([]);

    writeCache(null);
    expect(listCodexModels()).toEqual([]);
  });
});
