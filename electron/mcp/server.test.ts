import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleMCPToolCall, parseArgs, readTokenFile } from './server.js';
import type { MCPClient } from './client.js';

function makeClient(): MCPClient {
  return {
    createTask: vi.fn().mockResolvedValue({
      id: 'task-1',
      name: 'child',
      branchName: 'task/child',
      worktreePath: '/tmp/child',
      projectId: 'proj-1',
      agentId: 'agent-1',
      status: 'running',
      coordinatorTaskId: 'coord-1',
      exitCode: null,
    }),
    sendPrompt: vi.fn().mockResolvedValue({ queued: false }),
  } as unknown as MCPClient;
}

describe('MCP server tool handling', () => {
  it('rejects create_task without a prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('rejects create_task with a blank prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: '  ' },
    );

    expect(result).toMatchObject({ isError: true });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('rejects create_task with a non-string prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 123 },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('passes create_task prompt through to the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work' },
    );

    expect(result).not.toHaveProperty('isError');
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'child',
        prompt: 'do the work',
        coordinatorTaskId: 'coord-1',
      }),
    );
  });

  it('passes a valid create_task baseBranch through to the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', baseBranch: 'feature/base' },
    );

    expect(result).not.toHaveProperty('isError');
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'feature/base',
      }),
    );
  });

  it('rejects an invalid create_task baseBranch before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', baseBranch: '../main' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('baseBranch') }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('returns sent text when send_prompt writes immediately', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      content: [{ text: 'Prompt sent successfully.' }],
    });
    expect(client.sendPrompt).toHaveBeenCalledWith('task-1', 'continue');
  });

  it('rejects send_prompt without a taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a blank taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: '  ', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a non-string taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 123, prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt without a prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a blank prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: '  ' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a non-string prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 123 },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('returns queued text when send_prompt is parked behind another prompt', async () => {
    const client = makeClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({ queued: true });

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('Prompt queued') }],
    });
  });

  it('returns backend send_prompt errors as MCP errors', async () => {
    const client = makeClient();
    vi.mocked(client.sendPrompt).mockRejectedValueOnce(
      new Error('Prompt exceeds 65536 byte limit'),
    );

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: Prompt exceeds 65536 byte limit' }],
    });
  });

  it('returns backend create_task errors as MCP errors', async () => {
    const client = makeClient();
    vi.mocked(client.createTask).mockRejectedValueOnce(
      new Error('coordinator coord-1 is not registered'),
    );

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: coordinator coord-1 is not registered' }],
    });
  });

  it('rejects send_prompt from sub-task scoped MCP clients', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: 'task-1', coordinatorId: '' },
      'send_prompt',
      { taskId: 'task-2', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('not available to sub-tasks') }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });
});

describe('mind map tools', () => {
  it('returns an actionable operation error for the reported reasoning payload without blaming valid IDs', async () => {
    const client = { updateReasoning: vi.fn() } as unknown as MCPClient;
    const result = await handleMCPToolCall(
      { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true },
      'reasoning_update',
      {
        runId: null,
        newRunId: 'architecture-shallow-2026-09-15',
        expectedRevision: 0,
        activeId: 'repo',
        operations: [
          {
            type: 'insert_node',
            node: {
              id: 'repo',
              title: 'Repository architecture',
              kind: 'claim',
              status: 'accepted',
              summary: 'A content-only repository.',
            },
          },
        ],
      },
    );
    expect(result).toMatchObject({
      isError: true,
      content: [
        { text: expect.stringContaining('operations[0].type. Use one of: insert, update') },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Invalid graph ID');
    expect(client.updateReasoning).not.toHaveBeenCalled();
  });
  it('uses the session task, never a caller-supplied task ID', async () => {
    const client = {
      readMindMap: vi.fn().mockResolvedValue({ revision: 2 }),
      updateMindMap: vi.fn().mockResolvedValue({ revision: 3 }),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'mindmap_read', { taskId: 'other-task' }),
    ).not.toHaveProperty('isError');
    expect(client.readMindMap).toHaveBeenCalledWith('own-task');
    const update = {
      expectedRevision: 2,
      operations: [{ type: 'update', id: 'root', changes: { title: 'New title' } }],
    };
    expect(await handleMCPToolCall(context, 'mindmap_update', update)).not.toHaveProperty(
      'isError',
    );
    expect(client.updateMindMap).toHaveBeenCalledWith('own-task', update);
    expect(await handleMCPToolCall(context, 'create_task', { prompt: 'No' })).toHaveProperty(
      'isError',
      true,
    );
  });
  it('opens a canvas view for the session task and rejects unknown views before transport', async () => {
    const client = {
      openCanvas: vi.fn().mockResolvedValue({ ok: true, view: 'reasoning' }),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'canvas_open', { view: 'reasoning', taskId: 'other' }),
    ).not.toHaveProperty('isError');
    expect(client.openCanvas).toHaveBeenCalledWith('own-task', 'reasoning');
    expect(await handleMCPToolCall(context, 'canvas_open', { view: 'browser' })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mindmap, reasoning') }],
    });
    expect(client.openCanvas).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid operations before transport and exposes conflict failures', async () => {
    const client = {
      updateMindMap: vi.fn().mockRejectedValue(new Error('Read it again before editing.')),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '' };
    expect(
      await handleMCPToolCall(context, 'mindmap_update', {
        expectedRevision: 0,
        operations: [{ type: 'oops', id: 'root' }],
      }),
    ).toHaveProperty('isError', true);
    expect(client.updateMindMap).not.toHaveBeenCalled();
    expect(
      await handleMCPToolCall(context, 'mindmap_update', {
        expectedRevision: 0,
        operations: [{ type: 'update', id: 'root', changes: { title: 'Mine' } }],
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('Read it again') }],
    });
  });
});

describe('token file launches', () => {
  it('reads the session token from the 0600 config instead of argv or env', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-file-'));
    const file = path.join(directory, 'config.json');
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { 'parallel-code': { env: { PARALLEL_CODE_MCP_TOKEN: 'secret' } } },
        }),
      );
      expect(parseArgs(['--url', 'http://x', '--token-file', file, '--canvas-only'])).toMatchObject(
        {
          url: 'http://x',
          tokenFile: file,
          canvasOnly: true,
        },
      );
      expect(readTokenFile(file)).toBe('secret');
      fs.writeFileSync(file, '{"mcpServers":{}}');
      expect(readTokenFile(file)).toBe('');
      expect(readTokenFile(path.join(directory, 'missing.json'))).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports why a token file yielded no token before the generic usage error', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-file-'));
    const file = path.join(directory, 'config.json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(readTokenFile(path.join(directory, 'missing.json'))).toBe('');
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('token file'),
        expect.objectContaining({ code: 'ENOENT' }),
      );
      fs.writeFileSync(file, '{not json');
      expect(readTokenFile(file)).toBe('');
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('token file'),
        expect.any(SyntaxError),
      );
      fs.writeFileSync(file, '{"mcpServers":{}}');
      expect(readTokenFile(file)).toBe('');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('no PARALLEL_CODE_MCP_TOKEN'));
    } finally {
      error.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
