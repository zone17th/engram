import type { Config } from 'tailwindcss';

/**
 * Bản port của mockups/tw.js. Tên tiện ích phải khớp từng chữ với mockup,
 * vì markup của component được chép thẳng từ file HTML trong mockups/.
 */
const config: Config = {
  darkMode: ['class', "[data-theme='dark']"],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        surfaceAlt: 'var(--surface-alt)',
        line: 'var(--border)',
        lineStrong: 'var(--border-strong)',
        ink: 'var(--ink)',
        body: 'var(--body)',
        muted: 'var(--muted)',
        primary: 'var(--primary)',
        accent: 'var(--accent)',
        link: 'var(--link)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        error: 'var(--error)',
        paleAccent: 'var(--pale-accent)',
        paleBlue: 'var(--pale-blue)',
        palePink: 'var(--pale-pink)',
        paleOrange: 'var(--pale-orange)',
        deepPanel: 'var(--deep-panel)',
        darkFooter: 'var(--dark-footer)',
        aiPink: 'var(--ai-pink)',
        aiCyan: 'var(--ai-cyan)',
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        xxl: 'var(--r-xxl)',
        section: 'var(--r-section)',
        pill: 'var(--r-pill)',
      },
      maxWidth: { container: 'var(--container)' },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        card: 'var(--sh-card)',
        hero: 'var(--sh-hero)',
        agent: 'var(--sh-agent)',
        pop: 'var(--sh-pop)',
      },
    },
  },
  plugins: [],
};

export default config;
