import { useEffect, useState, type ReactNode } from 'react';

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

/**
 * Chart/card captions use the title itself as the disclosure surface. Wide
 * layouts start expanded; compact layouts start collapsed, without adding a
 * second "read context" row between the title and the visualization.
 */
export function CardCaption({
  title,
  children,
  className = '',
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const compact = useMediaQuery('(max-width: 48rem)');
  const [open, setOpen] = useState(!compact);
  useEffect(() => setOpen(!compact), [compact]);
  return (
    <details
      className={`card-caption ${className}`.trim()}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="card-title">{title}</span>
        <span className="card-caption-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="card-desc">{children}</div>
    </details>
  );
}
