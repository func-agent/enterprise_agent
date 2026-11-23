/**
 * Tailwind 类名合并工具 —— clsx 处理条件类名，tailwind-merge 解决冲突。
 *
 * 来源与许可：
 *   移植自 https://github.com/Ken-LK/agentscope-agui-scaffold
 *   （frontend/src/lib/utils.ts，许可 Apache License 2.0）
 *   Copyright 2024-2025 Ken-LK and the agentscope-agui-scaffold contributors.
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 className —— 后写的 Tailwind 工具类覆盖先写的同族类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
