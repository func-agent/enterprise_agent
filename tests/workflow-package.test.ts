import { readFile, readdir, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * 工作流代码包的依赖面守卫。
 *
 * `packages/workflow-core` 只把 `@eap/platform-core` 当作**类型**来源，
 * 运行时不加载它 —— 因此它必须留在 devDependencies，
 * 否则会把整个 platform-core 拖进生产安装面。
 */
describe('工作流代码包依赖面', () => {
  it('platform-core 只是开发期依赖，不进入生产安装面', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../packages/workflow-core/package.json', import.meta.url), 'utf8'),
    );
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@eap/platform-core');
    expect(manifest.devDependencies?.['@eap/platform-core']).toBe('1.0.0');
  });

  it('源码只做类型导入，不产生运行时依赖', async () => {
    const sourceDir = new URL('../packages/workflow-core/src/', import.meta.url);
    const files = await readdir(sourceDir);
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = await readFile(new URL(`${file}`, sourceDir), 'utf8');
      // 先去掉类型导入，剩下的才是真正的运行时导入。
      const runtimeImports = content
        .replace(/import\s+type\s+[^;]*?from\s+'[^']+';/g, '')
        .matchAll(/import\s+[^;]*?from\s+'@eap\/platform-core'/g);
      for (const match of runtimeImports) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('构建产物没有 platform-core 的运行时导入', async () => {
    const distDir = new URL('../packages/workflow-core/dist/', import.meta.url);
    let exists = true;
    try {
      await stat(distDir);
    } catch {
      exists = false;
    }
    if (!exists) return; // 尚未构建时跳过：产物校验交给构建流水线。
    const files = await readdir(distDir, { recursive: true } as { recursive: true });
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const content = await readFile(new URL(String(file), distDir), 'utf8');
      if (content.includes('@eap/platform-core')) offenders.push(String(file));
    }
    expect(offenders).toEqual([]);
  });
});
