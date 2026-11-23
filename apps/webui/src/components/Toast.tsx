/**
 * 右上角轻提示（Toast）—— 全局单例，任意组件可通过 useToast() 触发。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  const KIND_STYLE: Record<ToastKind, string> = {
    info: 'border-border bg-popover text-popover-foreground',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
  };
  const DOT_STYLE: Record<ToastKind, string> = {
    info: 'bg-primary',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    error: 'bg-red-500',
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed top-16 right-4 z-100 flex w-[calc(100vw-2rem)] max-w-xs flex-col gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${KIND_STYLE[item.kind]}`}
          >
            <span
              className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT_STYLE[item.kind]}`}
              aria-hidden="true"
            />
            <span className="flex-1 break-words">{item.message}</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setItems((prev) => prev.filter((it) => it.id !== item.id))}
              className="cursor-pointer opacity-60 transition-opacity hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用');
  return ctx;
}
