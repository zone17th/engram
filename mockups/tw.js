/* Tailwind Play CDN config — map token CSS vars sang tên tiện ích.
   Phải nạp SAU thẻ <script src="...tailwindcss.com"></script>. */
tailwind.config = {
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
        aiCyan: 'var(--ai-cyan)'
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        xxl: 'var(--r-xxl)',
        section: 'var(--r-section)',
        pill: 'var(--r-pill)'
      },
      maxWidth: { container: 'var(--container)' },
      fontFamily: {
        display: ['Plus Jakarta Sans', 'sans-serif'],
        sans: ['Inter', 'sans-serif'],
        mono: ['Sometype Mono', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        card: 'var(--sh-card)',
        hero: 'var(--sh-hero)',
        agent: 'var(--sh-agent)',
        pop: 'var(--sh-pop)'
      }
    }
  }
};
