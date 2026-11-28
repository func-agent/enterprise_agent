import type { WorkflowEdge, WorkflowNode } from './types.js';

/**
 * 稳定拓扑排序：同一轮可执行的节点保持定义中的先后顺序，边的遍历顺序不影响结果。
 * 存在环或悬空边导致无法覆盖全部节点时返回 null。
 */
export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] | null {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) indegree.set(node.id, 0);
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const order: WorkflowNode[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++];
    const node = byId.get(id);
    if (node) order.push(node);
    const nextNodes = [...(outgoing.get(id) ?? [])]
      .sort((left, right) => nodes.findIndex((node) => node.id === left) - nodes.findIndex((node) => node.id === right));
    for (const next of nextNodes) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? order : null;
}
