export const FONT_IDS = ['inter', 'system', 'serif', 'rounded', 'mono', 'atkinson'] as const;
export const FONTS = [
  { id: 'inter', label: 'Inter', stack: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'system', label: 'System', stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'rounded', label: 'Rounded', stack: 'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif' },
  { id: 'mono', label: 'Monospace', stack: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace' },
  { id: 'atkinson', label: 'Atkinson Hyperlegible', stack: '"Atkinson Hyperlegible", system-ui, sans-serif', asset: '/fonts/atkinson-regular.woff2' },
] as const;
export const SCALES = { default: 1, large: 1.125, xlarge: 1.25 } as const;
export const DENSITIES = { compact: { control: 40, gap: 8, padding: 16 }, default: { control: 44, gap: 16, padding: 16 }, comfortable: { control: 48, gap: 24, padding: 24 } } as const;
export const RADII = { sharp: [4, 6, 6, 8, 12], default: [8, 12, 12, 16, 24], round: [12, 16, 20, 20, 28] } as const;
