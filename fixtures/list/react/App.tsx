import { useMemo } from '@lynx-js/react';

import './App.css';

declare const lynx: {
  __globalProps?: {
    listRows?: number | string;
    queryItems?: { listRows?: number | string };
  };
};

const DEFAULT_ROWS = 10_000;

function requestedRows(): number {
  const value = Number(
    lynx.__globalProps?.listRows
      ?? lynx.__globalProps?.queryItems?.listRows
      ?? DEFAULT_ROWS,
  );
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ROWS;
}

export function App() {
  const rows = useMemo(
    () => Array.from({ length: requestedRows() }, (_, index) => index + 1),
    [],
  );

  return (
    <view className="list-page">
      <list className="list-surface" list-type="single" scroll-y>
        {rows.map((id) => (
          <list-item
            key={id}
            item-key={String(id)}
            estimated-main-axis-size-px={40}
          >
            <view className="list-cell">
              <text className="list-cell-key">{id}</text>
              <text className="list-cell-label">row {id}</text>
            </view>
          </list-item>
        ))}
      </list>
    </view>
  );
}
