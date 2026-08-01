/**
 * Docker Container Reconciliation Reaper Service (#2099)
 *
 * Periodic backstop to reap orphaned dev-env Docker compose containers.
 * Addresses issue #2099 where containers survive branch archiving/deletion due to
 * daemon restarts, manual docker invocations, or historical leaks.
 *
 * Architectural Contracts:
 * 1. Routing & Isolation: Uses runExecutorCommand to execute container inspection
 *    and compose teardown, maintaining compatibility with unix_user_mode (insulated/strict).
 * 2. Grace Period 1 (Container Age): Ignores containers created within the last 10 minutes
 *    to prevent racing with active container startup or worktree creation.
 * 3. Grace Period 2 (archived_at Recency): Ignores containers whose branch was archived
 *    within the last 10 minutes to allow in-flight archive teardowns (Component 1) to finish.
 */

import { stat } from 'node:fs/promises';
import { runWithSystemDatabaseScope } from '@agor/core/db';
import type { Branch } from '@agor/core/types';
import type { Application } from '../declarations.js';
import { runExecutorCommand } from '../utils/spawn-executor.js';

const GRACE_PERIOD_MS = 10 * 60_000; // 10 minutes

interface DockerContainerInfo {
  id: string;
  name: string;
  projectName: string;
  workingDir: string;
  createdAt: number; // Unix timestamp in ms
}

export const fsUtils = {
  pathExists: async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

export class DockerContainerReaper {
  private app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  /**
   * Run a reconciliation pass over live Docker compose containers.
   */
  async runReconciliationPass(): Promise<{ inspected: number; reaped: number }> {
    let inspectedCount = 0;
    let reapedCount = 0;

    try {
      const containers = await this.listRunningComposeContainers();
      inspectedCount = containers.length;

      const now = Date.now();

      for (const container of containers) {
        // Grace Period 1: Skip recently created containers (< 10 minutes old)
        if (now - container.createdAt < GRACE_PERIOD_MS) {
          continue;
        }

        const shouldReap = await this.evaluateContainerForReap(container, now);
        if (shouldReap) {
          console.log(
            `🧹 [DockerReaper] Reaping orphaned compose project '${container.projectName}' (working_dir: ${container.workingDir}, container: ${container.name})`
          );
          await this.reapComposeProject(container);
          reapedCount++;
        }
      }
    } catch (error) {
      console.warn(
        `[DockerReaper] Reconciliation sweep encountered an error:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return { inspected: inspectedCount, reaped: reapedCount };
  }

  /**
   * Evaluates whether a compose container should be reaped.
   */
  private async evaluateContainerForReap(
    container: DockerContainerInfo,
    now: number
  ): Promise<boolean> {
    // 1. If working directory does not exist on disk, container is orphaned
    const exists = await fsUtils.pathExists(container.workingDir);
    if (!exists) {
      return true;
    }

    // 2. Check DB status for corresponding branch
    const db = this.app.get('db');
    const branchesService = this.app.service('branches');

    const branch = await runWithSystemDatabaseScope(db, 'docker reaper branch lookup', async () => {
      const result = await branchesService.find({
        query: { path: container.workingDir, $limit: 1 },
        paginate: false,
      });
      const branches = Array.isArray(result) ? result : result.data;
      return branches[0] as Branch | undefined;
    });

    // If no branch row exists in DB matching this path, container is orphaned
    if (!branch) {
      return true;
    }

    // If branch is archived:
    if (branch.archived) {
      // Grace Period 2: Skip if archived_at is within the last 10 minutes to avoid racing with Component 1 archive teardown
      if (branch.archived_at) {
        const archivedAtMs = new Date(branch.archived_at).getTime();
        if (!Number.isNaN(archivedAtMs) && now - archivedAtMs < GRACE_PERIOD_MS) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Lists running Docker compose containers with project metadata.
   */
  private async listRunningComposeContainers(): Promise<DockerContainerInfo[]> {
    // Execute docker ps via executor for proper environment/isolation context
    const command = `docker ps --filter "label=com.docker.compose.project" --format "{{.ID}}|{{.Names}}|{{.Label \\"com.docker.compose.project\\"}}|{{.Label \\"com.docker.compose.project.working_dir\\"}}|{{.CreatedAt}}"`;

    const result = await runExecutorCommand(
      {
        command: 'docker.ps',
        params: { rawCommand: command },
      },
      {
        logPrefix: '[DockerReaper.ps]',
        timeoutMs: 30_000,
      }
    );

    if (!result.success || !result.data) {
      return [];
    }

    const output = (result.data as { output?: string })?.output ?? '';
    return this.parseDockerPsOutput(output);
  }

  /**
   * Parses docker ps output lines into DockerContainerInfo objects.
   */
  private parseDockerPsOutput(output: string): DockerContainerInfo[] {
    const containers: DockerContainerInfo[] = [];
    const lines = output.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const [id, name, projectName, workingDir, createdAtStr] = parts;
      if (!workingDir || !projectName) continue;

      const createdAt = createdAtStr ? new Date(createdAtStr).getTime() : 0;

      containers.push({
        id: id.trim(),
        name: name.trim(),
        projectName: projectName.trim(),
        workingDir: workingDir.trim(),
        createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
      });
    }

    return containers;
  }

  /**
   * Reaps a Docker compose project by calling docker compose down.
   */
  private async reapComposeProject(container: DockerContainerInfo): Promise<void> {
    const hasWorktree = await fsUtils.pathExists(container.workingDir);
    const teardownCommand = hasWorktree
      ? `docker compose down -v --remove-orphans`
      : `docker stop ${container.name} && docker rm ${container.name}`;

    await runExecutorCommand(
      {
        command: 'docker.reap',
        params: {
          rawCommand: teardownCommand,
          cwd: hasWorktree ? container.workingDir : undefined,
        },
      },
      {
        logPrefix: `[DockerReaper.reap ${container.projectName}]`,
        timeoutMs: 3 * 60_000,
      }
    );
  }
}
