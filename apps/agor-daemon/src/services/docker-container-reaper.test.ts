import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../declarations.js';
import { DockerContainerReaper, fsUtils } from './docker-container-reaper.js';

describe('DockerContainerReaper (#2099)', () => {
  it('skips containers younger than the 10-minute grace period', async () => {
    const app = { get: vi.fn(), service: vi.fn() } as unknown as Application;
    const reaper = new DockerContainerReaper(app);

    const now = Date.now();
    const recentCreatedAt = new Date(now - 2 * 60_000).toISOString(); // 2 min ago

    const dockerPsOutput = `c1|app-1|proj-1|/tmp/worktree-1|${recentCreatedAt}`;
    const spawnExecutor = await import('../utils/spawn-executor.js');
    vi.spyOn(spawnExecutor, 'runExecutorCommand').mockResolvedValue({
      success: true,
      data: { output: dockerPsOutput },
    });

    const result = await reaper.runReconciliationPass();
    expect(result.inspected).toBe(1);
    expect(result.reaped).toBe(0);
  });

  it('skips containers whose branch was archived within the last 10 minutes (archived_at grace period)', async () => {
    const app = { get: vi.fn(), service: vi.fn() } as unknown as Application;
    const reaper = new DockerContainerReaper(app);

    const now = Date.now();
    const oldContainerCreatedAt = new Date(now - 60 * 60_000).toISOString(); // 1 hour ago
    const recentArchivedAt = new Date(now - 3 * 60_000).toISOString(); // 3 min ago

    const dockerPsOutput = `c2|app-2|proj-2|/tmp/worktree-2|${oldContainerCreatedAt}`;
    const spawnExecutor = await import('../utils/spawn-executor.js');
    vi.spyOn(spawnExecutor, 'runExecutorCommand').mockResolvedValue({
      success: true,
      data: { output: dockerPsOutput },
    });

    vi.spyOn(fsUtils, 'pathExists').mockResolvedValue(true);

    const branchesServiceMock = {
      find: vi.fn().mockResolvedValue([
        {
          branch_id: 'b-2',
          path: '/tmp/worktree-2',
          archived: true,
          archived_at: recentArchivedAt,
        },
      ]),
    };
    (app.service as never) = vi.fn().mockReturnValue(branchesServiceMock);

    const result = await reaper.runReconciliationPass();
    expect(result.inspected).toBe(1);
    expect(result.reaped).toBe(0);
  });

  it('reaps containers when working directory does not exist on disk', async () => {
    const app = { get: vi.fn(), service: vi.fn() } as unknown as Application;
    const reaper = new DockerContainerReaper(app);

    const now = Date.now();
    const oldContainerCreatedAt = new Date(now - 60 * 60_000).toISOString(); // 1 hour ago

    const dockerPsOutput = `c3|app-3|proj-3|/tmp/worktree-deleted|${oldContainerCreatedAt}`;
    const spawnExecutor = await import('../utils/spawn-executor.js');
    const executorSpy = vi
      .spyOn(spawnExecutor, 'runExecutorCommand')
      .mockImplementation(async (payload) => {
        if (payload.command === 'docker.ps') {
          return { success: true, data: { output: dockerPsOutput } };
        }
        return { success: true, data: { output: 'reaped' } };
      });

    vi.spyOn(fsUtils, 'pathExists').mockResolvedValue(false);

    const result = await reaper.runReconciliationPass();
    expect(result.inspected).toBe(1);
    expect(result.reaped).toBe(1);
    expect(executorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'docker.reap' }),
      expect.anything()
    );
  });
});
