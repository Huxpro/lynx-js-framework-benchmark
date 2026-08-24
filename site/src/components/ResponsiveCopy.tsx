import type { ReactNode } from 'react';

import { useMediaQuery } from '../hooks';
import { useI18n } from '../i18n';

/**
 * Explanatory copy stays visible in wider reading layouts, then becomes a
 * native disclosure on compact screens. Titles, controls, and visualizations
 * remain outside so the primary result is never hidden.
 */
export function ResponsiveCopy({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const { text } = useI18n();
  const compact = useMediaQuery('(max-width: 48rem)');
  if (!compact) return <div className={className}>{children}</div>;

  return (
    <details className={`responsive-copy ${className}`.trim()}>
      <summary>
        <span>{label ?? text('Read context', '查看说明')}</span>
        <span className="responsive-copy-mark" aria-hidden="true" />
      </summary>
      <div className="responsive-copy-body">{children}</div>
    </details>
  );
}
