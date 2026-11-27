/**
 * @eap/workflow-core —— AI 工作流 V1 的领域逻辑层。
 *
 * 只包含可独立测试的纯逻辑，不依赖 Express / React / AG-UI / Keycloak / Provider，
 * 不读环境变量、不做 IO。执行所需的外部能力通过端口接口注入。
 *
 * 设计与契约见 docs/workflow-v1-design.md。
 */
export * from './types.js';
export * from './limits.js';
export * from './refs.js';
export * from './schema.js';
export * from './condition.js';
export * from './validate.js';
