import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import type { LodyWorktreeProject } from 'acp-extension-core';

/** Adapter-owned catalog identity; never fed into Harness execution or permissions. */
export class ProjectMetadata {
  constructor(private readonly root: string) {}
  async validate(value: unknown): Promise<LodyWorktreeProject | undefined> {
    if (value === undefined) return undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('originProjectPath' in value) ||
      typeof value.originProjectPath !== 'string' ||
      !isAbsolute(value.originProjectPath)
    )
      throw RequestError.invalidParams(undefined, 'invalid worktreeProject');
    const path = normalize(value.originProjectPath);
    if (!(await stat(path)).isDirectory())
      throw RequestError.invalidParams(undefined, 'originProjectPath is not a directory');
    return { version: 1, originProjectPath: path };
  }
  private path(id: string) {
    return join(this.root, `${encodeURIComponent(id)}.json`);
  }
  async read(id: string): Promise<LodyWorktreeProject | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(id), 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('originProjectPath' in value) ||
        typeof value.originProjectPath !== 'string' ||
        !isAbsolute(value.originProjectPath)
      )
        throw new Error('Invalid stored project metadata');
      return value as LodyWorktreeProject;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async write(id: string, value: LodyWorktreeProject): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path(id));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
