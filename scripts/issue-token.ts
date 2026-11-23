/**
 * 开发令牌签发工具（仅 AUTH_DEV_MODE=true 时可用）。
 *
 * 用法：
 *   npx tsx scripts/issue-token.ts [role] [tenantId] [deptId] [sensitivity]
 *
 * 例：
 *   npx tsx scripts/issue-token.ts admin t-default dept-general internal
 *   npx tsx scripts/issue-token.ts employee t-default dept-east confidential
 */
import { devTokenFor } from '@eap/platform-core';

async function main() {
  const [role = 'employee', tenantId = 't-default', deptId = 'dept-general', sensitivity = 'internal'] =
    process.argv.slice(2);

  const token = await devTokenFor(`dev-${role}`, {
    tenantId,
    role,
    deptId,
    sensitivity: sensitivity as 'public' | 'internal' | 'confidential',
  });

  process.stdout.write(token + '\n');
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
