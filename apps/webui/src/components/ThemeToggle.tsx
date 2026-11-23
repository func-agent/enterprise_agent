import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const THEME_KEY = 'eap.theme';
const THEME_MODES = ['light', 'dark', 'system'] as const;
type ThemeMode = (typeof THEME_MODES)[number];

function readThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (THEME_MODES.includes(stored as ThemeMode)) return stored as ThemeMode;
  } catch {
    // 本地存储不可用时仍可在当前页面切换主题。
  }
  return 'light';
}

function applyTheme(mode: ThemeMode): boolean {
  const dark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  return dark;
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    setIsDark(applyTheme(mode));
    try {
      window.localStorage.setItem(THEME_KEY, mode);
    } catch {
      // 隐私模式下只保留当前页面的主题状态。
    }

    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const followSystem = () => setIsDark(applyTheme('system'));
    media.addEventListener('change', followSystem);
    return () => media.removeEventListener('change', followSystem);
  }, [mode]);

  const Icon = isDark ? Sun : Moon;
  const label = isDark ? '切换到浅色模式' : '切换到深色模式';

  return (
    <button
      type="button"
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
      onClick={() => setMode(isDark ? 'light' : 'dark')}
      aria-label={label}
      title={label}
      aria-pressed={isDark}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
